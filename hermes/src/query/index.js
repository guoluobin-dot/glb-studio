/**
 * User Query - 用户交互确认模块
 *
 * When Hermes is uncertain about:
 * - Theme classification of a segment
 * - Which hook to use
 * - Title/cover design choice
 * - Video genre identification
 *
 * Creates pending queries in the database and provides:
 * 1. API endpoint to list pending queries
 * 2. API endpoint to answer a query
 * 3. Auto-timeout after 30 minutes (uses default/auto-continue)
 * 4. File-based notification (creates .pending files in upload/query/)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const AUTO_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class UserQuery {
  constructor(store, config, hooks = {}) {
    this.store = store;
    this.config = config;
    // 2026-09-24：超时自动答题后要通知外面推进项目。以前只有人工答题接口会调
    // clipper.resumeProject，自动超时答完就没人管了 → 有待确认项的自动粗剪永久卡在 pending_review。
    this.hooks = hooks || {};
    this.queryDir = join(__dirname, '..', '..', 'upload', 'query');
    this.ensureDir();
  }

  ensureDir() {
    if (!existsSync(this.queryDir)) {
      mkdirSync(this.queryDir, { recursive: true });
    }
  }

  /**
   * Create a new user query.
   * @param {Object} params
   * @param {number} params.projectId - associated clip project or video ID
   * @param {string} params.queryType - theme_confirm | hook_select | title_choose | genre_unknown | other
   * @param {string} params.question - the question text
   * @param {Object} params.context - additional context data
   * @param {string[]} params.options - answer options
   * @param {string} [params.defaultAnswer] - default if user doesn't respond in time
   * @returns {number} queryId
   */
  ask({ projectId, queryType, question, context = {}, options = ['Yes', 'No', 'Skip'], defaultAnswer = null }) {
    const queryId = this.store.addUserQuery({
      projectId,
      queryType,
      question,
      context,
      options,
      status: 'pending'
    });

    // Create a notification file for the user
    this._createNotificationFile(queryId, {
      projectId,
      queryType,
      question,
      options,
      timestamp: new Date().toISOString()
    });

    console.log(`[UserQuery] New query #${queryId}: ${question.substring(0, 60)}...`);
    return queryId;
  }

  /**
   * Answer a pending query.
   * @param {number} queryId
   * @param {string} answer
   */
  answer(queryId, answer) {
    this.store.answerUserQuery(queryId, answer);
    this._removeNotificationFile(queryId);
    console.log(`[UserQuery] Query #${queryId} answered: ${answer}`);
  }

  /**
   * Get all pending queries.
   */
  getPending() {
    return this.store.getPendingUserQueries(50);
  }

  /**
   * Get a specific query by ID.
   */
  get(queryId) {
    return this.store.getUserQuery(queryId);
  }

  /**
   * Check for auto-timeout queries and auto-resolve them.
   * Call this periodically (e.g., every minute).
   */
  checkTimeouts() {
    const pending = this.store.getPendingUserQueries(100);
    const now = Date.now();
    let autoResolved = 0;

    for (const q of pending) {
      // SQLite datetime('now') 存的是 UTC "YYYY-MM-DD HH:MM:SS"，
      // JS new Date("… …") 会按本地时区解析（北京 +8h），导致“刚创建就超时 8 小时”。
      // 补 'Z' 按 UTC 解析，还原真实创建时间。
      const createdAt = Date.parse(String(q.created_at).replace(' ', 'T') + 'Z');
      if (Number.isFinite(createdAt) && now - createdAt > AUTO_TIMEOUT_MS) {
        // 2026-09-24 改：以前直接选 options[0]（通常是 'Yes'/'保留'），等于超时后自动替用户
        // 拍板做了最激进的选择，用户回到看板只看到一句"已自动通过"。改成优先选保守项。
        const options = this._safeParse(q.options);
        const CONSERVATIVE = /^(skip|no|跳过|不保留|取消|否)$/i;
        const defaultAnswer = options.find((o) => CONSERVATIVE.test(String(o).trim())) || options[options.length - 1] || 'skip';
        this.store.answerUserQuery(q.id, `[AUTO] ${defaultAnswer}`);
        this._removeNotificationFile(q.id);
        autoResolved++;
        console.log(`[UserQuery] Query #${q.id} auto-resolved after timeout: ${defaultAnswer}`);
        try { this.hooks.onQueryResolved?.(q); } catch (err) { console.warn('[UserQuery] onQueryResolved 回调失败:', err.message); }
      }
    }

    if (autoResolved > 0) {
      console.log(`[UserQuery] Auto-resolved ${autoResolved} timed-out queries`);
    }

    return autoResolved;
  }

  /**
   * Check if a project has any pending queries.
   */
  hasPendingForProject(projectId) {
    const pending = this.store.getPendingUserQueries(100);
    return pending.some(q => q.project_id === projectId);
  }

  /**
   * Get all pending queries for a project.
   */
  getPendingForProject(projectId) {
    const pending = this.store.getPendingUserQueries(100);
    return pending.filter(q => q.project_id === projectId);
  }

  // ─── Notification files ───

  _createNotificationFile(queryId, data) {
    const filePath = join(this.queryDir, `query_${queryId}.pending`);
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  _removeNotificationFile(queryId) {
    const filePath = join(this.queryDir, `query_${queryId}.pending`);
    if (existsSync(filePath)) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
  }

  _safeParse(str) {
    if (!str) return [];
    try {
      return JSON.parse(str);
    } catch {
      return [];
    }
  }
}

export default UserQuery;
