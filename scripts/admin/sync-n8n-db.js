/**
 * sync-n8n-db.js — n8n SQLite Database Synchronizer
 *
 * PURPOSE:
 *   Syncs workflow JSON files into n8n's internal SQLite database.
 *   This ensures the master-workflow.json on disk matches what n8n
 *   actually runs. Runs only inside the Docker container (where the
 *   SQLite database exists).
 *
 * WHAT IT DOES:
 *   1. Reads master-workflow.json from the workflows directory
 *   2. Inserts/updates it in n8n's workflow_entity table
 *   3. Registers the Telegram webhook in webhook_entity
 *   4. Syncs the 0-resume-to-profile workflow if it exists
 *   5. Cleans up any obsolete workflow entries
 *
 * USAGE:
 *   node scripts/sync-n8n-db.js     (inside Docker container only)
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Configuration ───────────────────────────────────────────────────────────
const workflowsDir = process.env.WORKFLOWS_DIR
  || (fs.existsSync('/workflows') ? '/workflows' : path.join(__dirname, '../workflows'));
const n8nDbPath = process.env.N8N_DB_PATH || '/home/node/.n8n/database.sqlite';

// This script only runs inside Docker where the database exists
if (!fs.existsSync(n8nDbPath)) {
  console.error(`❌ n8n database not found at ${n8nDbPath}. Waiting for n8n initialization...`);
  process.exit(1);
}

// ── Open Database and Load Workflow ─────────────────────────────────────────
const db = new DatabaseSync(n8nDbPath);
try {
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec('PRAGMA journal_mode = WAL;');
} catch (_) {}

const now = new Date().toISOString().replace('T', ' ').substring(0, 23);
const master = JSON.parse(fs.readFileSync(path.join(workflowsDir, 'master-workflow.json'), 'utf8'));

// Workflow and webhook identifiers
const workflowId = process.env.N8N_WORKFLOW_ID || 'master-bot';
const webhookPath = (process.env.TELEGRAM_WEBHOOK_PATH || 'telegram-callback').replace(/^\/+/, '');
const newVersionId = crypto.randomUUID();

// ── Step 1: Update webhook node in the workflow JSON ────────────────────────
// Ensures the webhook path matches the configured TELEGRAM_WEBHOOK_PATH
const webhookNode = master.nodes.find(n => n.type === 'n8n-nodes-base.webhook');
if (webhookNode) {
  webhookNode.parameters.path = webhookPath;
  webhookNode.webhookId = newVersionId;
  webhookNode.id = newVersionId;
}

function getProjectId() {
  try {
    const proj = db.prepare('SELECT id FROM project LIMIT 1').get();
    if (proj && proj.id) return proj.id;
  } catch (_) {}
  try {
    const shared = db.prepare('SELECT projectId FROM shared_workflow LIMIT 1').get();
    if (shared && shared.projectId) return shared.projectId;
  } catch (_) {}
  try {
    const defaultProjId = 'default-personal-project';
    db.prepare(`
      INSERT OR IGNORE INTO project (id, name, type, createdAt, updatedAt)
      VALUES (?, 'Personal', 'personal', ?, ?)
    `).run(defaultProjId, now, now);
    return defaultProjId;
  } catch (_) {}
  return null;
}

// ── Step 2: Ensure workflow_entity exists (Upsert) ──────────────────────────
try {
  const existingMaster = db.prepare('SELECT id FROM workflow_entity WHERE id = ?').get(workflowId);
  if (!existingMaster) {
    db.prepare(`
      INSERT INTO workflow_entity (id, name, active, nodes, connections, settings, versionId, createdAt, updatedAt)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      workflowId,
      master.name || 'Master Workflow: Fetch, Score & Generate',
      JSON.stringify(master.nodes),
      JSON.stringify(master.connections),
      JSON.stringify(master.settings || {}),
      newVersionId,
      now,
      now
    );
    console.log(`✅ ${workflowId} entity inserted`);
  }

  const projId = getProjectId();
  if (projId) {
    db.prepare(`
      INSERT OR REPLACE INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt)
      VALUES (?, ?, 'workflow:owner', ?, ?)
    `).run(workflowId, projId, now, now);
    console.log(`✅ shared_workflow synced (${workflowId} -> ${projId})`);
  }
} catch (err) {
  console.error('Error inserting workflow_entity:', err.message);
}

// ── Step 3: Insert workflow history record ──────────────────────────────────
try {
  db.prepare(`
    INSERT INTO workflow_history (versionId, workflowId, authors, createdAt, updatedAt, nodes, connections, name, autosaved)
    VALUES (?, ?, 'owner', ?, ?, ?, ?, 'Master Workflow: Fetch, Score & Generate', 0)
  `).run(newVersionId, workflowId, now, now, JSON.stringify(master.nodes), JSON.stringify(master.connections));
  console.log(`✅ workflow_history inserted (version: ${newVersionId})`);
} catch (err) {
  console.error('Error inserting workflow_history:', err.message);
}

// ── Step 4: Update the main workflow entity with activeVersionId ────────────
try {
  const updateResult = db.prepare(
    'UPDATE workflow_entity SET nodes = ?, connections = ?, active = 1, activeVersionId = ?, versionId = ?, updatedAt = ?, settings = ? WHERE id = ?',
  ).run(JSON.stringify(master.nodes), JSON.stringify(master.connections), newVersionId, newVersionId, now, JSON.stringify(master.settings || {}), workflowId);
  console.log(`✅ ${workflowId} entity updated (changes: ${updateResult.changes})`);
} catch (err) {
  console.error('Error updating workflow_entity:', err.message);
}

// ── Step 5: Update published version pointer ────────────────────────────────
try {
  db.prepare(
    'INSERT OR REPLACE INTO workflow_published_version (workflowId, publishedVersionId, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
  ).run(workflowId, newVersionId, now, now);
  console.log('✅ workflow_published_version synced');
} catch (err) {
  console.error('Error updating published version:', err.message);
}

// ── Step 5b: Register webhook endpoint ──────────────────────────────────────
try {
  db.prepare('DELETE FROM webhook_entity WHERE workflowId = ?').run(workflowId);
  db.prepare(
    'INSERT INTO webhook_entity (workflowId, webhookPath, method, node, webhookId, pathLength) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(workflowId, webhookPath, 'POST', 'Webhook: Telegram Callback', newVersionId, 1);
  console.log(`✅ webhook_entity synced (path: ${webhookPath})`);
} catch (err) {
  console.error('Error updating webhook:', err.message);
}

// ── Step 6: Sync resume-to-profile workflow (wf0) ───────────────────────────
try {
  const wf0Path = path.join(workflowsDir, '0-resume-to-profile.json');
  if (fs.existsSync(wf0Path)) {
    const wf0 = JSON.parse(fs.readFileSync(wf0Path, 'utf8'));
    const existing = db.prepare('SELECT id FROM workflow_entity WHERE id = ?').get('wf0');

    if (existing) {
      db.prepare(
        'UPDATE workflow_entity SET name = ?, nodes = ?, connections = ?, updatedAt = ? WHERE id = ?',
      ).run(wf0.name, JSON.stringify(wf0.nodes), JSON.stringify(wf0.connections), now, 'wf0');
      console.log('✅ wf0 updated');
    } else {
      db.prepare(`
        INSERT INTO workflow_entity (id, name, active, nodes, connections, settings, versionId, createdAt, updatedAt)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        'wf0',
        wf0.name || 'Workflow 0: Upload Resume -> Parse -> Master Profile',
        JSON.stringify(wf0.nodes),
        JSON.stringify(wf0.connections),
        JSON.stringify(wf0.settings || {}),
        '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
        now,
        now,
      );
      console.log('✅ wf0 inserted');
    }

    const projId = getProjectId();
    if (projId) {
      db.prepare(`
        INSERT OR REPLACE INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt)
        VALUES (?, ?, 'workflow:owner', ?, ?)
      `).run('wf0', projId, now, now);
      console.log(`✅ shared_workflow synced (wf0 -> ${projId})`);
    }
  }
} catch (err) {
  console.error('Error syncing wf0:', err.message);
}

// ── Step 7: Clean up obsolete workflow entries ───────────────────────────────
// Remove any workflows that aren't master-bot or wf0
try {
  const deleteResult = db.prepare("DELETE FROM workflow_entity WHERE id NOT IN ('master-bot', 'wf0')").run();
  if (deleteResult.changes > 0) {
    console.log(`🧹 Cleaned up ${deleteResult.changes} obsolete workflows`);
  }
  db.prepare("DELETE FROM workflow_history WHERE workflowId NOT IN ('master-bot', 'wf0')").run();
  db.prepare("DELETE FROM webhook_entity WHERE workflowId NOT IN ('master-bot', 'wf0')").run();
} catch (err) {
  console.error('Error cleaning obsolete workflows:', err.message);
}

// ── Summary ─────────────────────────────────────────────────────────────────
const rows = db.prepare('SELECT id, name, updatedAt FROM workflow_entity').all();
console.log('📋 Final workflow entities in SQLite:', rows);

if (!rows.some(r => r.id === 'master-bot')) {
  console.error('❌ master-bot was not saved in SQLite. Exiting with retry code.');
  process.exit(1);
}
