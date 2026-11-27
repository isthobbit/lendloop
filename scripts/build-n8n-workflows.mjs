#!/usr/bin/env node
/**
 * Generates the importable n8n workflow JSON files in n8n/workflows/ from
 * n8n/src/lendloop-crypto.js plus the node definitions below.
 *
 * Why generate instead of hand-editing JSON exports?
 *  - The signing code exists once and is unit-tested (tests/signing.test.ts).
 *  - Exports are reviewable in PRs and guaranteed free of secrets: every
 *    secret is read at runtime from $env, never written into a node.
 *
 * Run: node scripts/build-n8n-workflows.mjs
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = readFileSync(join(root, "n8n/src/lendloop-crypto.js"), "utf8");
const outDir = join(root, "n8n/workflows");
mkdirSync(outDir, { recursive: true });

const ERROR_WORKFLOW_ID = "LLerrorHandler01";
const MAX_ATTEMPTS = 4;

function uuid(seed) {
  const h = createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function workflow({ id, name, build }) {
  const nodes = [];
  const connections = {};
  let x = 0;
  const api = {
    add(node, pos) {
      const n = {
        id: uuid(`${id}:${node.name}`),
        position: pos ?? [(x += 240), 300],
        ...node,
      };
      nodes.push(n);
      return n.name;
    },
    link(from, to, output = 0) {
      connections[from] ??= { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: "main", index: 0 });
    },
    code(name, jsCode, pos, extra = {}) {
      return api.add(
        { name, type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode: jsCode.trim() + "\n" }, ...extra },
        pos,
      );
    },
    /**
     * A signed call to Convex with a re-signing retry loop:
     *   Sign -> HTTP --ok--> (next)
     *            \--error--> Retry gate -> Backoff (2^n s) -> Sign (fresh nonce + timestamp)
     * Non-retryable statuses (400/401/403/413/422) fail immediately.
     */
    signedCall({ label, method, route, bodyJs, quietOn410 = false, swallowFinal = false }) {
      const sign = `Sign: ${label}`;
      const http = `HTTP: ${label}`;
      const gate = `Retry gate: ${label}`;
      const wait = `Backoff: ${label}`;
      const bx = x;
      api.code(
        sign,
        `${LIB}
const input = $input.first().json;
const ctx = input.ctx;
const attempt = input.attempt || 0;
const base = String($env.LENDLOOP_CONVEX_SITE_URL || '').replace(/\\/$/, '');
if (!base) throw new Error('LENDLOOP_CONVEX_SITE_URL is not set');
const body = ${bodyJs};
const headers = llSign({ keys: $env.LENDLOOP_N2C_KEYS, method: '${method}', route: '${route}', body });
return [{ json: { ctx, attempt, request: { url: base + '${route}', body, headers } } }];`,
      );
      const httpParams = {
        method,
        url: "={{ $json.request.url }}",
        sendHeaders: true,
        specifyHeaders: "json",
        jsonHeaders: "={{ JSON.stringify($json.request.headers) }}",
        options: { timeout: 10000 },
      };
      if (method !== "GET") {
        Object.assign(httpParams, {
          sendBody: true,
          contentType: "raw",
          rawContentType: "application/json",
          body: "={{ $json.request.body }}",
        });
      }
      api.add({
        name: http,
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4.2,
        onError: "continueErrorOutput",
        parameters: httpParams,
      });
      api.code(
        gate,
        `const prev = $('${sign}').first().json;
// Report only the error itself (never the signed request/headers).
const j = $input.first().json;
const e = j.error || {};
const detail = (typeof e === 'string' ? e : [e.httpCode || e.status || '', e.message || '', e.description || ''].join(' ').trim() || 'unknown error').slice(0, 300);
${quietOn410 ? `if (/\\b410\\b/.test(detail)) {
  console.log('[lendloop] ${label}: ticket no longer valid (already handled or superseded); stopping quietly');
  return [];
}` : ""}
if (/\\b(400|401|403|413|422)\\b/.test(detail)) {
  throw new Error('${label} rejected by Convex (not retryable): ' + detail);
}
const attempt = (prev.attempt || 0) + 1;
if (attempt >= ${MAX_ATTEMPTS}) {
  ${swallowFinal ? `console.error('[lendloop] ${label} failed after ' + attempt + ' attempts: ' + detail);
  return [];` : `throw new Error('${label} failed after ' + attempt + ' attempts: ' + detail);`}
}
return [{ json: { ctx: prev.ctx, attempt } }];`,
        [bx + 480, 520],
      );
      api.add(
        {
          name: wait,
          type: "n8n-nodes-base.wait",
          typeVersion: 1.1,
          webhookId: uuid(`${id}:${wait}:webhook`),
          parameters: { amount: "={{ Math.min(30, Math.pow(2, $json.attempt)) }}", unit: "seconds" },
        },
        [bx + 720, 520],
      );
      api.link(sign, http);
      api.link(http, gate, 1);
      api.link(gate, wait);
      api.link(wait, sign);
      return { first: sign, last: http };
    },
  };

  build(api);

  return {
    id,
    name,
    active: false,
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
      ...(id === ERROR_WORKFLOW_ID ? {} : { errorWorkflow: ERROR_WORKFLOW_ID }),
      // Data minimization inside n8n: successful runs (which briefly hold an
      // email address) are not persisted, including runs started by hand from
      // the editor. Failed runs are kept for debugging and pruned by
      // EXECUTIONS_DATA_MAX_AGE.
      saveDataSuccessExecution: "none",
      saveDataErrorExecution: "all",
      saveManualExecutions: false,
      callerPolicy: "workflowsFromSameOwner",
    },
    pinData: {},
    tags: [],
  };
}

/* ------------------------------------------------------------------ */
/* 1. Loan event notifications (Convex -> n8n webhook)                  */
/* ------------------------------------------------------------------ */
const loanEvents = workflow({
  id: "LLloanEvents0001",
  name: "LendLoop: Loan event notifications",
  build(w) {
    const hook = w.add({
      name: "Loan event webhook",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      webhookId: uuid("loan-events-webhook"),
      parameters: {
        httpMethod: "POST",
        path: "lendloop-loan-events",
        responseMode: "responseNode",
        options: { rawBody: true },
      },
    });
    const verify = w.code(
      "Verify signature",
      `${LIB}
// 1) Verify the HMAC over the RAW body (byte-exact), bound to this route.
const item = $input.first();
let raw;
try {
  raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
} catch (e) {
  raw = JSON.stringify(item.json.body);
}
const result = llVerify({ keys: $env.LENDLOOP_C2N_KEYS, headers: item.json.headers, method: 'POST', route: 'n8n:loan-events', body: raw });
let valid = result.ok;
let reason = result.ok ? null : result.reason;

// 2) Replay protection: each nonce is accepted once within a 10 minute window.
if (valid) {
  const store = $getWorkflowStaticData('global');
  const now = Date.now();
  store.nonces = Object.fromEntries(Object.entries(store.nonces || {}).filter(([, exp]) => exp > now));
  const key = result.keyId + ':' + result.nonce;
  if (store.nonces[key]) { valid = false; reason = 'replayed_nonce'; }
  else store.nonces[key] = now + 600000;
}

// 3) Strict shape check. The payload carries no personal data by design.
let event = null;
if (valid) {
  try { event = JSON.parse(raw); } catch (e) { valid = false; reason = 'invalid_json'; }
}
if (valid && !(event && typeof event.eventId === 'string' && typeof event.loanId === 'string'
    && typeof event.type === 'string' && /^[0-9a-f]{64}$/.test(String(event.ticket)))) {
  valid = false; reason = 'bad_payload';
}
if (!valid) console.warn('[lendloop] rejected webhook: ' + reason);

// Headers and the raw body are dropped here; downstream nodes only see ctx.
return [{ json: { valid, reason, ctx: valid ? { eventId: event.eventId, type: event.type, loanId: event.loanId, ticket: event.ticket } : null } }];`,
    );
    const ok = w.add({
      name: "Signature valid?",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
          conditions: [
            {
              id: uuid("valid-cond"),
              leftValue: "={{ $json.valid }}",
              rightValue: true,
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
    });
    const accept = w.add({
      name: "Respond 202",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1.1,
      parameters: { respondWith: "json", responseBody: '{"accepted":true}', options: { responseCode: 202 } },
    });
    const reject = w.add(
      {
        name: "Respond 401",
        type: "n8n-nodes-base.respondToWebhook",
        typeVersion: 1.1,
        parameters: { respondWith: "json", responseBody: '{"error":"unauthorized"}', options: { responseCode: 401 } },
      },
      [960, 520],
    );
    const redeem = w.signedCall({
      label: "redeem ticket",
      method: "POST",
      route: "/n8n/notifications/redeem",
      bodyJs: "JSON.stringify({ ticket: ctx.ticket })",
      quietOn410: true,
    });
    const deliver = w.code(
      "Compose + deliver (mock)",
      `${LIB}
// The ONLY node that sees the recipient's email. It is used, masked in logs,
// and not passed downstream.
const d = $input.first().json;
const ctx = $('Sign: redeem ticket').first().json.ctx;
const range = d.startDate + ' to ' + d.endDate;
const templates = {
  'loan.requested': ['New borrow request', 'Hi ' + d.recipient.firstName + ', a neighbour asked to borrow your ' + d.toolName + ' (' + range + '). Open LendLoop to approve or decline.'],
  'loan.approved':  ['Request approved', 'Good news ' + d.recipient.firstName + ': your request for the ' + d.toolName + ' (' + range + ') was approved.'],
  'loan.declined':  ['Request declined', 'Hi ' + d.recipient.firstName + ', your request for the ' + d.toolName + ' (' + range + ') was declined.'],
  'loan.cancelled': ['Request withdrawn', 'Hi ' + d.recipient.firstName + ', a request for your ' + d.toolName + ' (' + range + ') was withdrawn.'],
  'loan.returned':  ['Loan closed', 'Thanks ' + d.recipient.firstName + '! The ' + d.toolName + ' was marked as returned.'],
};
const [subject, text] = templates[d.type] || ['LendLoop update', 'There is an update on one of your loans.'];

// ---- Mock channel. Swap this block for a Send Email / Slack node that uses an
// ---- n8n credential (see README > "Real notification channel").
console.log('[lendloop] notify ' + llMaskEmail(d.recipient.email) + ' | ' + subject + ' | ' + text);

return [{ json: { ctx: { loanId: ctx.loanId, ticket: ctx.ticket, channel: 'mock', subject } } }];`,
    );
    const ack = w.signedCall({
      label: "record notification",
      method: "POST",
      route: "/n8n/automation-events",
      bodyJs:
        "JSON.stringify({ events: [{ kind: 'notification_sent', loanId: ctx.loanId, ticket: ctx.ticket, channel: ctx.channel, executionId: String($execution.id) }] })",
    });
    const done = w.code(
      "Check write-back",
      `const results = $input.first().json.results || [];
const bad = results.filter((r) => r.status === 'rejected');
if (bad.length) throw new Error('Convex rejected notification write-back: ' + JSON.stringify(bad));
return [{ json: { ok: true, results } }];`,
    );

    w.link(hook, verify);
    w.link(verify, ok);
    w.link(ok, accept, 0);
    w.link(ok, reject, 1);
    w.link(accept, redeem.first);
    w.link(redeem.last, deliver, 0);
    w.link(deliver, ack.first);
    w.link(ack.last, done, 0);
  },
});

/* ------------------------------------------------------------------ */
/* 2. Daily overdue reminders (n8n schedule -> Convex)                  */
/* ------------------------------------------------------------------ */
const overdue = workflow({
  id: "LLoverdueRemind1",
  name: "LendLoop: Daily overdue reminders",
  build(w) {
    const trigger = w.add({
      name: "Every day 08:00",
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2,
      parameters: { rule: { interval: [{ field: "days", daysInterval: 1, triggerAtHour: 8 }] } },
    });
    // "Run now" for demos and for `n8n execute --id=LLoverdueRemind1`.
    const manual = w.add(
      { name: "Run now (manual)", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {} },
      [240, 120],
    );
    const start = w.code("Start", "return [{ json: { ctx: {} } }];");
    // Step 1: one claim-check ticket per overdue loan. The response holds ids
    // and tickets only, so this node's output never contains personal data.
    const issue = w.signedCall({
      label: "issue reminder tickets",
      method: "POST",
      route: "/n8n/reminders/tickets",
      bodyJs: "'{}'",
    });
    const prepare = w.code(
      "Any reminders due?",
      `// Convex already left out loans reminded today (server-side idempotency).
const tickets = ($input.first().json.tickets || []).map((t) => t.ticket);
if (tickets.length === 0) return [];
return [{ json: { ctx: { tickets } } }];`,
    );
    // Step 2: redeem the tickets for exactly what each reminder needs. Convex
    // records every release of an address in its audit log.
    const redeem = w.signedCall({
      label: "redeem reminder tickets",
      method: "POST",
      route: "/n8n/reminders/redeem",
      bodyJs: "JSON.stringify({ tickets: ctx.tickets })",
    });
    const send = w.code(
      "Send reminders (mock)",
      `${LIB}
// With the redeem response, the only place that holds an email address.
const reminders = $input.first().json.reminders || [];
if (reminders.length === 0) return [];
const events = [];
for (const r of reminders) {
  const base = { loanId: r.loanId, ticket: r.ticket, channel: 'mock', executionId: String($execution.id) };
  try {
    const text = 'Hi ' + r.borrower.firstName + ', the ' + r.toolName + ' was due back on ' + r.dueDate
      + ' (' + r.daysOverdue + ' day' + (r.daysOverdue === 1 ? '' : 's') + ' ago). Please arrange the return with the lender.';
    // ---- Mock channel; swap for Send Email / Slack with an n8n credential.
    console.log('[lendloop] reminder -> ' + llMaskEmail(r.borrower.email) + ' | ' + text);
    events.push({ kind: 'reminder_sent', ...base });
  } catch (e) {
    events.push({ kind: 'reminder_failed', ...base });
  }
}
// Emails stop here: the write-back carries ids, tickets and outcomes only.
return [{ json: { ctx: { events } } }];`,
    );
    const writeBack = w.signedCall({
      label: "write back reminders",
      method: "POST",
      route: "/n8n/automation-events",
      bodyJs: "JSON.stringify({ events: ctx.events })",
    });
    const check = w.code(
      "Check write-back",
      `const results = $input.first().json.results || [];
const bad = results.filter((r) => r.status === 'rejected');
const failedSends = ($('Sign: write back reminders').first().json.ctx.events || []).filter((e) => e.kind === 'reminder_failed');
if (bad.length) throw new Error('Convex rejected ' + bad.length + ' reminder write-back(s): ' + JSON.stringify(bad).slice(0, 300));
if (failedSends.length) throw new Error(failedSends.length + ' reminder(s) could not be delivered (recorded as reminder_failed)');
return [{ json: { recorded: results.filter((r) => r.status === 'recorded').length, duplicates: results.filter((r) => r.status === 'duplicate').length } }];`,
    );
    w.link(trigger, start);
    w.link(manual, start);
    w.link(start, issue.first);
    w.link(issue.last, prepare, 0);
    w.link(prepare, redeem.first);
    w.link(redeem.last, send, 0);
    w.link(send, writeBack.first);
    w.link(writeBack.last, check, 0);
  },
});

/* ------------------------------------------------------------------ */
/* 3. Error handler (set as errorWorkflow on 1 and 2)                   */
/* ------------------------------------------------------------------ */
const errorHandler = workflow({
  id: ERROR_WORKFLOW_ID,
  name: "LendLoop: Error handler",
  build(w) {
    const trig = w.add({
      name: "On workflow error",
      type: "n8n-nodes-base.errorTrigger",
      typeVersion: 1,
      parameters: {},
    });
    const build = w.code(
      "Build error report",
      `const d = $input.first().json;
const report = {
  workflow: (d.workflow && d.workflow.name) || 'unknown',
  node: (d.execution && d.execution.lastNodeExecuted) || 'unknown',
  message: String((d.execution && d.execution.error && d.execution.error.message) || 'unknown error').slice(0, 1000),
  executionId: d.execution && d.execution.id ? String(d.execution.id) : undefined,
};
// Always visible in n8n's own logs, even if Convex is unreachable.
console.error('[lendloop] workflow failure: ' + report.workflow + ' / ' + report.node + ': ' + report.message);
return [{ json: { ctx: { report } } }];`,
    );
    const send = w.signedCall({
      label: "report error",
      method: "POST",
      route: "/n8n/automation-errors",
      bodyJs: "JSON.stringify(ctx.report)",
      swallowFinal: true,
    });
    w.link(trig, build);
    w.link(build, send.first);
  },
});

for (const [file, wf] of [
  ["01-loan-event-notifications.json", loanEvents],
  ["02-daily-overdue-reminders.json", overdue],
  ["03-error-handler.json", errorHandler],
]) {
  writeFileSync(join(outDir, file), JSON.stringify(wf, null, 2) + "\n");
  console.log(`wrote n8n/workflows/${file} (${wf.nodes.length} nodes)`);
}
