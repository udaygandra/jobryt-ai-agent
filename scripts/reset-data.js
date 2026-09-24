const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');

// Core config files that should NEVER be wiped
const protectedFiles = new Set([
  'master-profile.json',
  'master-profile.example.json',
  'resume-template.html'
]);

// Tracking files to reset to empty arrays
const arrayFiles = [
  'seen_jobs.json',
  'pending_approval.json',
  'qualified_jobs.json',
  'rejected_jobs.json',
  'logged_jobs.json',
  'processed_jobs.json'
];

function resetData() {
  console.log('🧹 Resetting pipeline tracking data for a clean fresh run...\n');

  // 1. Reset array files to []
  for (const filename of arrayFiles) {
    const filePath = path.join(dataDir, filename);
    fs.writeFileSync(filePath, JSON.stringify([], null, 2));
    console.log(`  ✔ Reset ${filename} -> []`);
  }

  // 2. Reset dashboard.csv with header
  const csvPath = path.join(dataDir, 'dashboard.csv');
  const csvHeader = 'Timestamp,Job ID,Source,Title,Company,Score,Status,Missing Skills\n';
  fs.writeFileSync(csvPath, csvHeader);
  console.log('  ✔ Reset dashboard.csv -> [CSV Headers]');

  // 3. Reset Adzuna role rotation index
  const roleIdxPath = path.join(dataDir, 'adzuna_role_idx.json');
  fs.writeFileSync(roleIdxPath, JSON.stringify({ idx: 0 }, null, 2));
  console.log('  ✔ Reset adzuna_role_idx.json -> {"idx": 0}');

  console.log('\n✨ Fresh run environment ready! You can now trigger your workflow in n8n or run your scripts.');
}

resetData();
