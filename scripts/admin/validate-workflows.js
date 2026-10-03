const fs = require('fs');

const files = ['workflows/0-resume-to-profile.json', 'workflows/master-workflow.json'];

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

let errors = 0;
for (const file of files) {
  console.log(`\n=== Validating ${file} ===`);
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const n of wf.nodes) {
    if (n.type === 'n8n-nodes-base.code') {
      const code = n.parameters?.jsCode || '';
      try {
        new AsyncFunction('$input', '$env', 'require', code);
        console.log(`  ✔ [${n.name}] syntax valid (${code.split('\n').length} lines)`);
      } catch (err) {
        console.error(`  ❌ [${n.name}] SYNTAX ERROR: ${err.message}`);
        errors++;
      }
    }
  }
}

if (errors > 0) {
  console.error(`\n❌ Total syntax errors found: ${errors}`);
  process.exit(1);
} else {
  console.log(`\n✅ All workflow code nodes have 100% valid JavaScript syntax!`);
}
