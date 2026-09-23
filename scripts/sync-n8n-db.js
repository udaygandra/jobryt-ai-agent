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

const rows = db.prepare('SELECT id, name, updatedAt FROM workflow_entity').all();
console.log('Updated rows in SQLite:', rows);
