import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  MessageSendOpts,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  url_private_download?: string;
}

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getLastTimestamp: () => string;
  onBackfillComplete?: () => void;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    threadTs?: string;
  }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private backfillInProgress = false;
  private periodicBackfillTimer: ReturnType<typeof setInterval> | null = null;

  private opts: SlackChannelOpts;
  private botToken: string;
  private trustedBotIds: string[] = [];
  private mentionRequiredBotIds: string[] = [];

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile([
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_TRUSTED_BOT_IDS',
      'SLACK_MENTION_REQUIRED_BOT_IDS',
    ]);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.botToken = botToken;

    this.trustedBotIds = env.SLACK_TRUSTED_BOT_IDS
      ? env.SLACK_TRUSTED_BOT_IDS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // Mention-required bots: trigger only when the bot's message @mentions jAI,
    // same rule as humans. Lists are intended to be non-overlapping with
    // SLACK_TRUSTED_BOT_IDS; if a bot id appears in both, mention-required wins
    // (more restrictive).
    this.mentionRequiredBotIds = env.SLACK_MENTION_REQUIRED_BOT_IDS
      ? env.SLACK_MENTION_REQUIRED_BOT_IDS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      const msgFiles = (msg as { files?: SlackFile[] }).files;
      if (!msg.text && (!msgFiles || msgFiles.length === 0)) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages. When an
      // @mention arrives from a thread, reply_thread_ts is stamped on the
      // message so the orchestrator can route the response back into that thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;
      const msgBotId = (msg as { bot_id?: string }).bot_id;
      const isMentionRequiredBot =
        isBotMessage &&
        msg.user !== this.botUserId &&
        !!msgBotId &&
        this.mentionRequiredBotIds.includes(msgBotId);
      // Mention-required wins over trusted when both are listed for the same id
      // (more restrictive). In normal use the lists should be disjoint.
      const isTrustedBot =
        !isMentionRequiredBot &&
        isBotMessage &&
        msg.user !== this.botUserId &&
        !!msgBotId &&
        this.trustedBotIds.includes(msgBotId);

      let senderName: string;
      let content = msg.text || '';
      let replyThreadTs: string | undefined;
      let effectiveIsBotMessage: boolean;

      const mentionPattern = this.botUserId ? `<@${this.botUserId}>` : null;

      if (!isBotMessage) {
        // Regular user message — only process real Slack @mentions (<@BOTID>).
        // Plain text containing the bot name does not trigger a response.
        if (!mentionPattern || !content.includes(mentionPattern)) {
          return;
        }
        // Prepend trigger so TRIGGER_PATTERN matches in the router.
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
        // Capture thread context: use existing thread root or this message's ts.
        // This travels with the message through the pipeline so the correct thread
        // is targeted even when multiple mentions are in-flight simultaneously.
        replyThreadTs = (msg as { thread_ts?: string }).thread_ts || msg.ts;
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
        effectiveIsBotMessage = false;
      } else if (isTrustedBot) {
        // Trusted workflow bot — trigger without @mention, always reply in thread.
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
        replyThreadTs = (msg as { thread_ts?: string }).thread_ts || msg.ts;
        senderName = (await this.resolveBotName(msgBotId)) || msgBotId;
        effectiveIsBotMessage = false;
      } else if (isMentionRequiredBot) {
        // Bot whose messages we listen to but only act on when jAI is @mentioned.
        // Without the mention, fall through to context-only tracking.
        if (mentionPattern && content.includes(mentionPattern)) {
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
          replyThreadTs = (msg as { thread_ts?: string }).thread_ts || msg.ts;
          senderName = (await this.resolveBotName(msgBotId)) || msgBotId;
          effectiveIsBotMessage = false;
        } else {
          senderName = (await this.resolveBotName(msgBotId)) || msgBotId;
          effectiveIsBotMessage = true;
        }
      } else {
        // Own bot message or untrusted bot — pass through for context tracking only.
        senderName = ASSISTANT_NAME;
        effectiveIsBotMessage = true;
      }

      // Download any attached files so the agent can read them
      if (!effectiveIsBotMessage && msgFiles && msgFiles.length > 0) {
        const group = this.opts.registeredGroups()[jid];
        if (group) {
          const filePaths = await this.downloadAttachments(
            msgFiles,
            group.folder,
          );
          if (filePaths.length > 0) {
            content +=
              '\n' + filePaths.map((p) => `[Attachment: ${p}]`).join('\n');
          }
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msgBotId || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: effectiveIsBotMessage,
        is_bot_message: effectiveIsBotMessage,
        reply_thread_ts: replyThreadTs,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    // Backfill messages missed while the process was stopped or the machine was asleep.
    // Also registers a reconnect listener so backfill runs again after every
    // sleep/wake cycle (Socket Mode reconnects without restarting the process).
    await this.backfillMissedMessages();
    const socketClient = (
      this.app as unknown as {
        receiver?: {
          client?: { on?: (event: string, cb: () => void) => void };
        };
      }
    ).receiver?.client;
    if (socketClient?.on) {
      socketClient.on('connected', () => {
        this.backfillMissedMessages().catch((err) =>
          logger.warn({ err }, 'Backfill after reconnect failed'),
        );
      });
      logger.info('Slack: reconnect backfill listener registered');
    } else {
      logger.warn(
        'Slack: reconnect listener could not be registered — periodic backfill is the only wake-recovery mechanism',
      );
    }

    // Periodic backfill runs every 2 minutes as a safety net for sleep/wake cycles,
    // missed reconnect events, and any gaps in Socket Mode delivery.
    // storeMessage uses INSERT OR REPLACE so re-storing seen messages is safe.
    this.periodicBackfillTimer = setInterval(
      () => {
        this.backfillMissedMessages().catch((err) =>
          logger.warn({ err }, 'Periodic Slack backfill failed'),
        );
      },
      2 * 60 * 1000,
    );

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: MessageSendOpts,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = opts?.threadTs;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
        }
      }
      logger.info({ jid, length: text.length, threadTs }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.periodicBackfillTimer) {
      clearInterval(this.periodicBackfillTimer);
      this.periodicBackfillTimer = null;
    }
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async resolveBotName(botId: string): Promise<string | undefined> {
    try {
      const result = await this.app.client.bots.info({ bot: botId });
      return result.bot?.name;
    } catch (err) {
      logger.debug({ botId, err }, 'Failed to resolve Slack bot name');
      return undefined;
    }
  }

  private async backfillMissedMessages(): Promise<void> {
    if (this.backfillInProgress) return;
    if (!this.botUserId) return;
    this.backfillInProgress = true;
    try {
      await this._doBackfill();
    } finally {
      this.backfillInProgress = false;
    }
    // After backfill, trigger recovery for any messages that were stored in DB
    // but not yet processed by the agent (e.g. machine slept between lastTimestamp
    // advancing and the agent actually running).
    this.opts.onBackfillComplete?.();
  }

  private async _doBackfill(): Promise<void> {
    const lastTs = this.opts.getLastTimestamp();
    const oldest = lastTs
      ? (new Date(lastTs).getTime() / 1000).toString()
      : (Date.now() / 1000 - 216000).toString(); // first run: look back 60 hours

    const groups = this.opts.registeredGroups();
    const mentionPattern = `<@${this.botUserId}>`;
    let backfilled = 0;

    for (const [jid, _group] of Object.entries(groups)) {
      if (!jid.startsWith('slack:')) continue;
      const channelId = jid.replace('slack:', '');
      try {
        const result = await this.app.client.conversations.history({
          channel: channelId,
          oldest,
          limit: 100,
        });

        // Slack returns messages newest-first. We do all async work (name
        // resolution, file downloads) up front, then store in oldest-first
        // order. This prevents a race where the main poll loop fires mid-batch,
        // advances last_timestamp to a newer message, and permanently loses
        // older messages that haven't been stored yet.
        type PendingMsg = Parameters<typeof this.opts.onMessage>[1];
        const pending: PendingMsg[] = [];

        for (const msg of result.messages || []) {
          if (!msg.ts) continue;
          const text = (msg as { text?: string }).text || '';
          const files = (msg as { files?: SlackFile[] }).files;
          const msgBotId = (msg as { bot_id?: string }).bot_id;
          const userId = (msg as { user?: string }).user || '';

          // Skip our own messages
          if (msgBotId === this.botUserId || userId === this.botUserId)
            continue;

          const isTrustedBot =
            !!msgBotId && this.trustedBotIds.includes(msgBotId);
          const hasMention = !!mentionPattern && text.includes(mentionPattern);

          // Trusted bots trigger without @mention; everyone else needs one
          if (!isTrustedBot && !hasMention) continue;
          // Mention-required bots still need the @mention even in backfill
          if (
            msgBotId &&
            this.mentionRequiredBotIds.includes(msgBotId) &&
            !hasMention
          )
            continue;

          const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
          const senderName =
            (userId ? await this.resolveUserName(userId) : undefined) ||
            userId ||
            'unknown';

          let content = text;
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }

          // Download any attached files
          if (files && files.length > 0) {
            const group = groups[jid];
            if (group) {
              const filePaths = await this.downloadAttachments(
                files,
                group.folder,
              );
              if (filePaths.length > 0) {
                content +=
                  '\n' + filePaths.map((p) => `[Attachment: ${p}]`).join('\n');
              }
            }
          }

          const replyThreadTs =
            (msg as { thread_ts?: string }).thread_ts || msg.ts;

          pending.push({
            id: msg.ts,
            chat_jid: jid,
            sender: userId,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: false,
            is_bot_message: false,
            reply_thread_ts: replyThreadTs,
          });
        }

        // Store oldest-first so last_timestamp advances monotonically and
        // the main loop never skips an older message.
        pending.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        for (const msg of pending) {
          this.opts.onMessage(jid, msg);
          backfilled++;
        }
      } catch (err) {
        logger.warn({ err, jid }, 'Backfill: failed to fetch Slack history');
      }
    }

    if (backfilled > 0) {
      logger.info({ backfilled }, 'Backfilled missed Slack messages');
    }
  }

  private async downloadAttachments(
    files: SlackFile[],
    groupFolder: string,
  ): Promise<string[]> {
    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachmentsDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });

    const containerPaths: string[] = [];
    for (const file of files) {
      if (!file.url_private_download) continue;
      try {
        const response = await fetch(file.url_private_download, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (!response.ok) {
          logger.warn(
            { fileId: file.id, status: response.status },
            'Slack file download failed',
          );
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const filename = `${Date.now()}-${file.name || file.id}`;
        fs.writeFileSync(path.join(attachmentsDir, filename), buffer);
        containerPaths.push(`/workspace/group/attachments/${filename}`);
        logger.debug({ filename }, 'Slack attachment saved');
      } catch (err) {
        logger.warn({ err, fileId: file.id }, 'Failed to download Slack file');
      }
    }
    return containerPaths;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          ...(item.threadTs ? { thread_ts: item.threadTs } : {}),
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
