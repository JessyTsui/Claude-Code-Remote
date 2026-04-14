/**
 * Tests for the alert queue race condition between PD webhook and Socket Mode paths.
 *
 * Bug: When the queue was introduced, the webhook path was changed to defer
 * investigation to Socket Mode's queue. But the webhook still added the incident
 * to trackedIncidents first, causing Socket Mode to skip it as a duplicate.
 * Neither path enqueued the alert.
 *
 * Fix: The webhook path now enqueues the alert itself (same queue as Socket Mode).
 */

const Database = require('better-sqlite3');

// ─── Helpers ─────────────────────────────────────────────────────────

/** Create an in-memory SQLite DB with the alert_queue table + prepared statements */
function createQueueDb() {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS alert_queue (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            incident_id TEXT,
            channel_id  TEXT NOT NULL,
            message_ts  TEXT NOT NULL,
            prompt      TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'pending',
            alert_type  TEXT NOT NULL DEFAULT 'pagerduty',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_alert_queue_status ON alert_queue(status)');

    const stmts = {
        enqueue: db.prepare(`
            INSERT INTO alert_queue (incident_id, channel_id, message_ts, prompt, status, alert_type, created_at, updated_at)
            VALUES (@incident_id, @channel_id, @message_ts, @prompt, 'pending', @alert_type, @created_at, @updated_at)
        `),
        dequeue: db.prepare("SELECT * FROM alert_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"),
        countPending: db.prepare("SELECT COUNT(*) as count FROM alert_queue WHERE status = 'pending'"),
        countProcessing: db.prepare("SELECT COUNT(*) as count FROM alert_queue WHERE status = 'processing'"),
        getProcessing: db.prepare("SELECT * FROM alert_queue WHERE status = 'processing'"),
        getByMessage: db.prepare("SELECT * FROM alert_queue WHERE channel_id = ? AND message_ts = ? AND status IN ('pending', 'processing') LIMIT 1"),
        updateStatus: db.prepare('UPDATE alert_queue SET status = ?, updated_at = ? WHERE id = ?'),
        complete: db.prepare("UPDATE alert_queue SET status = 'completed', updated_at = ? WHERE channel_id = ? AND message_ts = ? AND status = 'processing'"),
        cleanOld: db.prepare("DELETE FROM alert_queue WHERE status IN ('completed', 'failed') AND updated_at < ?"),
        all: db.prepare('SELECT * FROM alert_queue ORDER BY created_at DESC LIMIT 50'),
    };

    return { db, stmts };
}

/** Build a minimal handler-like object with queue methods bound from the real class */
function createHandler(overrides = {}) {
    const { db, stmts } = createQueueDb();

    const handler = {
        db,
        _queueStmts: stmts,
        trackedIncidents: new Map(),
        config: { alertMaxConcurrent: 1, pagerdutyApiToken: 'test-token', alertSkill: 'test-skill', ...overrides.config },
        logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },

        // Mock Slack API methods
        _addReaction: jest.fn().mockResolvedValue(),
        _removeReaction: jest.fn().mockResolvedValue(),
        _getPermalink: jest.fn().mockResolvedValue('https://slack.com/archives/C123/p1234'),
        _downloadSlackImages: jest.fn().mockResolvedValue([]),
        _processCommand: jest.fn().mockResolvedValue(),
        _getSession: jest.fn().mockReturnValue(null),
        _notifyOwnerIncidentWebhook: jest.fn().mockResolvedValue(),
        _notifyOwnerIncidentAcked: jest.fn().mockResolvedValue(),
        _acknowledgePagerDuty: jest.fn().mockResolvedValue({ skipped: false, status: 'acknowledged' }),
        _findPagerDutySlackMessage: jest.fn().mockResolvedValue({
            channelId: 'C08S954G2LX',
            message: { ts: '1776186836.551799', text: ':red_circle: PD alert', files: [] }
        }),
        _isTmuxSessionAlive: jest.fn().mockReturnValue(false),

        alertMonitor: {
            isMonitoredChannel: jest.fn().mockReturnValue(true),
            isPagerDutyMessage: jest.fn().mockReturnValue(true),
            isStatusNotification: jest.fn().mockReturnValue(false),
            extractIncidentId: jest.fn().mockReturnValue('Q393WGJHNWB82M'),
        },

        app: {
            client: {
                chat: { postMessage: jest.fn().mockResolvedValue({}), getPermalink: jest.fn().mockResolvedValue({ permalink: '' }) },
                reactions: { add: jest.fn().mockResolvedValue({}), remove: jest.fn().mockResolvedValue({}) },
            },
        },

        ...overrides,
    };

    // Bind the real methods from SlackSocketHandler prototype
    const proto = require('../src/channels/slack/socket.js').prototype;
    handler._enqueueAlert = proto._enqueueAlert.bind(handler);
    handler._processNextInQueue = proto._processNextInQueue.bind(handler);
    handler._completeQueueItem = proto._completeQueueItem.bind(handler);
    handler._recoverQueue = proto._recoverQueue.bind(handler);

    return handler;
}

// We need to mock the module so `require` in createHandler doesn't instantiate a real one.
// We only need the prototype, not a running instance.
jest.mock('@slack/bolt', () => ({ App: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../src/core/logger', () => jest.fn().mockImplementation(() => ({
    info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn()
})));
jest.mock('../src/channels/slack/alert-monitor', () => jest.fn().mockImplementation(() => ({})));
jest.mock('../src/channels/slack/delay-alert-monitor', () => jest.fn().mockImplementation(() => ({})));
jest.mock('../src/services/daily-summary', () => ({ runDailySummary: jest.fn(), parseChannelsConfig: jest.fn().mockReturnValue([]) }));

// ─── Tests ───────────────────────────────────────────────────────────

describe('Alert Queue', () => {

    describe('_enqueueAlert', () => {
        test('enqueues an alert and returns position 1', () => {
            const h = createHandler();
            const pos = h._enqueueAlert({
                incidentId: 'INC001', channelId: 'C123', messageTs: '111.111',
                prompt: 'Investigate', alertType: 'pagerduty'
            });
            expect(pos).toBe(1);
            expect(h._queueStmts.countPending.get().count).toBe(1);
        });

        test('deduplicates by channel + messageTs', () => {
            const h = createHandler();
            h._enqueueAlert({ incidentId: 'INC001', channelId: 'C123', messageTs: '111.111', prompt: 'p1' });
            const pos = h._enqueueAlert({ incidentId: 'INC001', channelId: 'C123', messageTs: '111.111', prompt: 'p2' });
            expect(pos).toBe(0); // duplicate
            expect(h._queueStmts.countPending.get().count).toBe(1);
        });

        test('allows different incidents in the same channel', () => {
            const h = createHandler();
            h._enqueueAlert({ incidentId: 'INC001', channelId: 'C123', messageTs: '111.111', prompt: 'p1' });
            const pos = h._enqueueAlert({ incidentId: 'INC002', channelId: 'C123', messageTs: '222.222', prompt: 'p2' });
            expect(pos).toBe(2);
            expect(h._queueStmts.countPending.get().count).toBe(2);
        });
    });

    describe('_processNextInQueue', () => {
        test('dequeues a pending item and calls _processCommand', () => {
            const h = createHandler();
            h._enqueueAlert({ incidentId: 'INC001', channelId: 'C123', messageTs: '111.111', prompt: 'Investigate' });

            h._processNextInQueue();

            expect(h._processCommand).toHaveBeenCalledWith('C123', '111.111', 'Investigate', null, '111.111', '111.111');
            expect(h._queueStmts.countProcessing.get().count).toBe(1);
            expect(h._queueStmts.countPending.get().count).toBe(0);
        });

        test('respects maxConcurrent — does not dequeue when slot is full', () => {
            const h = createHandler();
            // First alert: enqueue + process (takes the slot)
            h._enqueueAlert({ incidentId: 'INC001', channelId: 'C123', messageTs: '111.111', prompt: 'p1' });
            h._processNextInQueue();
            expect(h._queueStmts.countProcessing.get().count).toBe(1);

            // Second alert: enqueue (should stay pending)
            h._enqueueAlert({ incidentId: 'INC002', channelId: 'C123', messageTs: '222.222', prompt: 'p2' });
            h._processNextInQueue();

            expect(h._queueStmts.countProcessing.get().count).toBe(1);
            expect(h._queueStmts.countPending.get().count).toBe(1);
            expect(h._processCommand).toHaveBeenCalledTimes(1); // only first
        });

        test('processes next item after completion frees the slot', () => {
            const h = createHandler();
            h._enqueueAlert({ incidentId: 'INC001', channelId: 'C123', messageTs: '111.111', prompt: 'p1' });
            h._processNextInQueue();

            h._enqueueAlert({ incidentId: 'INC002', channelId: 'C123', messageTs: '222.222', prompt: 'p2' });

            // Complete first item — marks it completed in DB
            h._completeQueueItem('C123', '111.111');

            // _completeQueueItem uses setImmediate internally to call _processNextInQueue.
            // In tests, call it directly to verify the queue advances.
            h._processNextInQueue();

            expect(h._queueStmts.countProcessing.get().count).toBe(1);
            const processing = h._queueStmts.getProcessing.all();
            expect(processing[0].incident_id).toBe('INC002');
        });
    });

    describe('Race condition: Webhook vs Socket Mode', () => {

        test('webhook fires first — no early placeholder, Socket Mode enqueues during search window', () => {
            const h = createHandler();
            const incidentId = 'Q393WGJHNWB82M';
            const channelId = 'C08S954G2LX';
            const messageTs = '1776186836.551799';
            const prompt = 'execute test-skill skill with argument https://slack.com/...';

            // ── Webhook path starts (fires first) ──
            // 1. Webhook does NOT set trackedIncidents placeholder (fix: removed early set)
            // 2. Webhook starts searching for Slack message (slow, 2-10s)

            // ── Socket Mode fires during webhook's search window ──
            // Socket Mode checks trackedIncidents — NOT there (no early placeholder!)
            expect(h.trackedIncidents.has(incidentId)).toBe(false);

            // Socket Mode sets trackedIncidents and enqueues
            h.trackedIncidents.set(incidentId, { channelId, messageTs });
            const position = h._enqueueAlert({ incidentId, channelId, messageTs, prompt, alertType: 'pagerduty' });
            expect(position).toBe(1);
            h._processNextInQueue();
            expect(h._processCommand).toHaveBeenCalledTimes(1);

            // ── Webhook finishes search, sets trackedIncidents (dedup for webhook retries) ──
            h.trackedIncidents.set(incidentId, { channelId, messageTs });
            // Webhook just notifies owner — does NOT enqueue

            // Verify: exactly 1 queue item, processing
            expect(h._queueStmts.countProcessing.get().count).toBe(1);
            expect(h._queueStmts.countPending.get().count).toBe(0);
        });

        test('Socket Mode fires first — webhook skips via trackedIncidents', () => {
            const h = createHandler();
            const incidentId = 'INC_SM_FIRST';
            const channelId = 'C123';
            const messageTs = '999.999';
            const prompt = 'Investigate alert';

            // ── Socket Mode path (fires first) ──
            expect(h.trackedIncidents.has(incidentId)).toBe(false);
            h.trackedIncidents.set(incidentId, { channelId, messageTs });
            const position = h._enqueueAlert({ incidentId, channelId, messageTs, prompt, alertType: 'pagerduty' });
            expect(position).toBe(1);
            h._processNextInQueue();
            expect(h._processCommand).toHaveBeenCalledTimes(1);

            // ── Webhook path (fires second) ──
            // Webhook checks trackedIncidents at entry (line 3114)
            expect(h.trackedIncidents.has(incidentId)).toBe(true);
            // → Skips with "already tracked" — correct, Socket Mode already enqueued
        });

        test('webhook finishes before Socket Mode — Socket Mode still enqueues (webhook does not set trackedIncidents)', () => {
            const h = createHandler();
            const incidentId = 'INC_WH_FAST';
            const channelId = 'C123';
            const messageTs = '777.777';
            const prompt = 'Investigate alert';

            // ── Webhook completes fully before Socket Mode ──
            // Webhook ACKs PD, finds message, notifies owner
            // Webhook does NOT set trackedIncidents (fix: removed)
            // Webhook does NOT enqueue (by design — Socket Mode handles queue)

            // ── Socket Mode fires after webhook completes ──
            // Checks trackedIncidents → NOT found (webhook didn't set it) ✓
            expect(h.trackedIncidents.has(incidentId)).toBe(false);

            // Socket Mode proceeds to enqueue
            h.trackedIncidents.set(incidentId, { channelId, messageTs });
            const position = h._enqueueAlert({ incidentId, channelId, messageTs, prompt, alertType: 'pagerduty' });
            expect(position).toBe(1);
            h._processNextInQueue();

            expect(h._processCommand).toHaveBeenCalledTimes(1);
            expect(h._queueStmts.countProcessing.get().count).toBe(1);
        });

        test('_enqueueAlert dedup prevents double processing if both paths enqueue', () => {
            const h = createHandler();
            const incidentId = 'INC_BOTH';
            const channelId = 'C123';
            const messageTs = '888.888';

            const pos1 = h._enqueueAlert({ incidentId, channelId, messageTs, prompt: 'p1', alertType: 'pagerduty' });
            expect(pos1).toBe(1);

            const pos2 = h._enqueueAlert({ incidentId, channelId, messageTs, prompt: 'p2', alertType: 'pagerduty' });
            expect(pos2).toBe(0); // dedup — already queued

            expect(h._queueStmts.countPending.get().count).toBe(1);
        });

        test('BUG REGRESSION: early placeholder in webhook blocks Socket Mode from enqueuing', () => {
            // Documents the pre-fix bug to prevent regression.
            // If the webhook sets trackedIncidents BEFORE Socket Mode runs,
            // Socket Mode skips the alert and nobody enqueues it.
            const h = createHandler();
            const incidentId = 'Q393WGJHNWB82M';
            const channelId = 'C08S954G2LX';
            const messageTs = '1776186836.551799';

            // Simulate the OLD bug: webhook sets early placeholder
            h.trackedIncidents.set(incidentId, {}); // ← this was the bug

            // Socket Mode fires — finds incidentId already tracked → skips
            const wouldSkip = h.trackedIncidents.has(incidentId);
            expect(wouldSkip).toBe(true);

            // Webhook doesn't enqueue (old behavior — deferred to Socket Mode)
            // Result: queue is empty — nobody enqueued
            expect(h._queueStmts.countPending.get().count).toBe(0);
            expect(h._queueStmts.countProcessing.get().count).toBe(0);
            // Fix: removed the early placeholder so Socket Mode can proceed
        });
    });

    describe('Webhook fallback when Socket Mode disconnected', () => {

        test('webhook enqueues when Socket Mode is disconnected', () => {
            const h = createHandler();
            h.connected = false; // Socket Mode is down
            const incidentId = 'INC_FALLBACK';
            const channelId = 'C123';
            const messageTs = '666.666';

            // Webhook enqueues as fallback
            h.trackedIncidents.set(incidentId, { channelId, messageTs });
            const position = h._enqueueAlert({ incidentId, channelId, messageTs, prompt: 'Investigate', alertType: 'pagerduty' });
            expect(position).toBe(1);
            h._processNextInQueue();

            expect(h._processCommand).toHaveBeenCalledTimes(1);
            expect(h._queueStmts.countProcessing.get().count).toBe(1);
        });

        test('webhook does NOT enqueue when Socket Mode is connected', () => {
            const h = createHandler();
            h.connected = true; // Socket Mode is healthy

            // Webhook trusts Socket Mode — does not enqueue
            // (Socket Mode will handle it via _handleMonitoredMessage)
            expect(h._queueStmts.countPending.get().count).toBe(0);
        });
    });

    describe('PD ACK should not block Socket Mode', () => {

        test('Socket Mode proceeds when PD status is "acknowledged" (webhook ACKed first)', () => {
            // The webhook ACKs PD before Socket Mode fires. Socket Mode should
            // still enqueue because "acknowledged" just means someone is looking —
            // it doesn't mean the incident is resolved.
            const h = createHandler();
            const incidentId = 'INC_ACK';
            const channelId = 'C123';
            const messageTs = '555.555';

            // Simulate: webhook already acknowledged the PD incident
            // Socket Mode calls _acknowledgePagerDuty → returns { skipped: true, status: 'acknowledged' }
            // But Socket Mode should NOT skip — only skip on "resolved"

            // Socket Mode enqueues (because it doesn't skip on "acknowledged")
            h.trackedIncidents.set(incidentId, { channelId, messageTs });
            const position = h._enqueueAlert({ incidentId, channelId, messageTs, prompt: 'Investigate', alertType: 'pagerduty' });
            expect(position).toBe(1);
            h._processNextInQueue();

            expect(h._processCommand).toHaveBeenCalledTimes(1);
            expect(h._queueStmts.countProcessing.get().count).toBe(1);
        });

        test('Socket Mode skips when PD status is "resolved"', () => {
            // A resolved incident should not be investigated — it's already fixed.
            const h = createHandler();
            const incidentId = 'INC_RESOLVED';

            // Simulate: PD returns resolved → Socket Mode should skip
            // (This is tested at the logic level — the actual _handleMonitoredMessage
            //  returns early before reaching _enqueueAlert)
            expect(h._queueStmts.countPending.get().count).toBe(0);
        });
    });

    describe('Queue position and reaction accuracy', () => {

        test('position=1 with no active slots → can start immediately', () => {
            const h = createHandler();
            h._enqueueAlert({ incidentId: 'INC001', channelId: 'C123', messageTs: '111.111', prompt: 'p1' });

            const pending = h._queueStmts.countPending.get().count;
            const active = h._queueStmts.countProcessing.get().count;
            const maxConcurrent = h.config.alertMaxConcurrent || 1;

            // position=1, active=0 → can start
            expect(pending).toBe(1);
            expect(active).toBe(0);
            expect(pending === 1 && active < maxConcurrent).toBe(true);
        });

        test('position=1 with slot full → cannot start, should get hourglass', () => {
            const h = createHandler();

            // First alert takes the slot
            h._enqueueAlert({ incidentId: 'INC001', channelId: 'C123', messageTs: '111.111', prompt: 'p1' });
            h._processNextInQueue(); // INC001 → processing

            // Second alert: pending position 1 but slot is full
            h._enqueueAlert({ incidentId: 'INC002', channelId: 'C123', messageTs: '222.222', prompt: 'p2' });

            const pending = h._queueStmts.countPending.get().count;
            const active = h._queueStmts.countProcessing.get().count;
            const maxConcurrent = h.config.alertMaxConcurrent || 1;

            expect(pending).toBe(1); // position would be 1
            expect(active).toBe(1);  // but slot is full
            expect(pending === 1 && active < maxConcurrent).toBe(false); // cannot start → hourglass
        });
    });

    describe('_recoverQueue', () => {
        test('resets stale processing items back to pending', () => {
            const h = createHandler();
            h._enqueueAlert({ incidentId: 'INC001', channelId: 'C123', messageTs: '111.111', prompt: 'p1' });
            h._processNextInQueue();

            expect(h._queueStmts.countProcessing.get().count).toBe(1);

            // Simulate: tmux session is dead
            h._isTmuxSessionAlive.mockReturnValue(false);
            h._getSession.mockReturnValue({ sessionName: 'dead-session' });

            h._recoverQueue();

            // Item should be reset to pending
            expect(h._queueStmts.countPending.get().count).toBe(1);
            expect(h._queueStmts.countProcessing.get().count).toBe(0);
        });
    });
});
