const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

const db = new DatabaseSync('/home/node/.n8n/database.sqlite');
const now = new Date().toISOString().replace('T', ' ').substring(0, 23);

const wf1 = JSON.parse(fs.readFileSync('/workflows/1-fetch-dedup-score.json', 'utf8'));
const master = JSON.parse(fs.readFileSync('/workflows/master-workflow.json', 'utf8'));

// Update wf1
const updateWf1 = db.prepare('UPDATE workflow_entity SET nodes = ?, connections = ?, updatedAt = ? WHERE id = ?');
const resWf1 = updateWf1.run(JSON.stringify(wf1.nodes), JSON.stringify(wf1.connections), now, 'wf1');
console.log('wf1 changes:', resWf1.changes);

// Update master-bot
const updateMaster = db.prepare('UPDATE workflow_entity SET nodes = ?, connections = ?, updatedAt = ? WHERE id = ?');
const resMaster = updateMaster.run(JSON.stringify(master.nodes), JSON.stringify(master.connections), now, 'master-bot');
console.log('master-bot changes:', resMaster.changes);

// Also update Pl3SnOg7XpNhnWB0 if present
const updatePl = db.prepare('UPDATE workflow_entity SET nodes = ?, connections = ?, updatedAt = ? WHERE id = ?');
const resPl = updatePl.run(JSON.stringify(wf1.nodes), JSON.stringify(wf1.connections), now, 'Pl3SnOg7XpNhnWB0');
console.log('Pl3SnOg7XpNhnWB0 changes:', resPl.changes);

// Sync wf0 (Resume to Profile)
try {
  const wf0Path = '/workflows/0-resume-to-profile.json';
  if (fs.existsSync(wf0Path)) {
    const wf0 = JSON.parse(fs.readFileSync(wf0Path, 'utf8'));
    const existingWf0 = db.prepare('SELECT id FROM workflow_entity WHERE id = ?').get('wf0');
    if (existingWf0) {
      const updateWf0 = db.prepare('UPDATE workflow_entity SET name = ?, nodes = ?, connections = ?, updatedAt = ? WHERE id = ?');
      updateWf0.run(wf0.name, JSON.stringify(wf0.nodes), JSON.stringify(wf0.connections), now, 'wf0');
      console.log('wf0 updated');
    } else {
      const insertWf0 = db.prepare(`
        INSERT INTO workflow_entity (id, name, active, nodes, connections, settings, versionId, createdAt, updatedAt)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
      `);
      insertWf0.run(
        'wf0',
        wf0.name || 'Workflow 0: Upload Resume -> Parse -> Master Profile',
        JSON.stringify(wf0.nodes),
        JSON.stringify(wf0.connections),
        JSON.stringify(wf0.settings || {}),
        '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
        now,
        now
      );
      // Link to project
      const shared = db.prepare('SELECT projectId FROM shared_workflow LIMIT 1').get();
      if (shared && shared.projectId) {
        db.prepare(`
          INSERT OR IGNORE INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt)
          VALUES (?, ?, 'workflow:owner', ?, ?)
        `).run('wf0', shared.projectId, now, now);
      }
      console.log('wf0 inserted');
    }
  }
} catch (e) {
  console.error('Error syncing wf0:', e.message);
}

const rows = db.prepare('SELECT id, name, updatedAt FROM workflow_entity').all();
console.log('Updated rows in SQLite:', rows);
