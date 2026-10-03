const { DateTime } = require('luxon');
const { calculateYearsOfExperience, normalizeCategorizedSkills } = require('../scripts/engine/resume-to-profile');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
  passedTests++;
  console.log(`   ✔ ${message}`);
}

console.log('🧪 Running Experience Calculator & Skills Categorization Unit Tests...\n');

// ── Test 1: Fixed Reference Date & Exact Duration ────────────────────────────
console.log('Test 1: Month-precision single interval');
const refDate = DateTime.fromISO('2024-06-01');
// Jan 2023 to Dec 2023 = 12 months = 1.0 years
const exp1 = [{ dates: 'Jan 2023 – Dec 2023' }];
const yoe1 = calculateYearsOfExperience(exp1, refDate);
assert(yoe1 === 1.0, `Expected 1.0 years, got ${yoe1}`);

// ── Test 2: Overlapping Date Ranges (Concurrent Roles) ──────────────────────
console.log('\nTest 2: Overlapping date ranges (no double counting)');
// Role A: Jan 2020 to Dec 2022 (36 months)
// Role B: Jan 2021 to June 2021 (overlapping within Role A)
// Merged total should be 36 months = 3.0 years
const exp2 = [
  { dates: 'Jan 2020 – Dec 2022' },
  { dates: 'Jan 2021 – June 2021' }
];
const yoe2 = calculateYearsOfExperience(exp2, refDate);
assert(yoe2 === 3.0, `Expected 3.0 years for merged overlapping roles, got ${yoe2}`);

// ── Test 3: "Present" / "Current" Role with Mock Reference Date ─────────────
console.log('\nTest 3: "Present" role with fixed mock date');
// Start: July 2022, Reference: June 2024
// July 2022 to June 2024 = 24 months = 2.0 years
const exp3 = [{ dates: 'July 2022 – Present' }];
const yoe3 = calculateYearsOfExperience(exp3, refDate);
assert(yoe3 === 2.0, `Expected 2.0 years for July 2022 – Present as of June 2024, got ${yoe3}`);

// ── Test 4: Year-Only Dates ──────────────────────────────────────────────────
console.log('\nTest 4: Year-only dates (e.g. 2018 - 2020)');
// 2018-01-01 to 2020-12-31 = 36 months = 3.0 years
const exp4 = [{ dates: '2018 - 2020' }];
const yoe4 = calculateYearsOfExperience(exp4, refDate);
assert(yoe4 === 3.0, `Expected 3.0 years for 2018 - 2020, got ${yoe4}`);

// ── Test 5: Complex Real-World Candidate Multi-Role with Gap ────────────────
console.log('\nTest 5: Multi-role career with gaps');
// Role 1: Aug 2017 – June 2018 (11 months)
// Gap: July 2018 – Jan 2019 (not counted)
// Role 2: Feb 2019 – June 2021 (29 months)
// Gap: July 2021
// Role 3: Aug 2021 – July 2022 (12 months)
// Role 4: July 2022 – June 2024 (24 months, with July 2022 contiguous/overlapping with Role 3)
const exp5 = [
  { dates: 'July 2022 – Present' },
  { dates: 'Aug 2021 – July 2022' },
  { dates: 'Feb 2019 – June 2021' },
  { dates: 'Aug 2017 – June 2018' }
];
const yoe5 = calculateYearsOfExperience(exp5, refDate);
assert(yoe5 >= 6.0 && yoe5 <= 6.5, `Expected ~6.2 years for candidate as of June 2024, got ${yoe5}`);

// ── Test 6: Skills Categorization Normalization ──────────────────────────────
console.log('\nTest 6: Skills categorization validation & deduplication');
const flatSkills = ['React.js', 'Vue.js', 'Node.js', 'PostgreSQL', 'Docker', 'Agile', 'SpecialTool'];
const rawCategorized = [
  {
    category: 'Frontend',
    items: ['React.js', 'Vue.js', 'NonExistentSkill'] // NonExistentSkill should be pruned
  },
  {
    category: 'Backend & Data',
    items: ['Node.js', 'PostgreSQL', 'React.js'] // React.js is a duplicate, should not be re-assigned
  },
  {
    category: 'DevOps',
    items: ['Docker']
  },
  {
    category: 'Empty Category',
    items: [] // Empty category should be omitted
  }
];

const normalized = normalizeCategorizedSkills(rawCategorized, flatSkills);

// Checks:
// 1. NonExistentSkill is NOT in any category
const allItems = normalized.flatMap(c => c.items);
assert(!allItems.includes('NonExistentSkill'), 'Non-existent skills must not be fabricated');

// 2. Every item in flatSkills appears in exactly one category
assert(allItems.length === flatSkills.length, `Expected ${flatSkills.length} total categorized items, got ${allItems.length}`);
for (const s of flatSkills) {
  const occurrences = allItems.filter(i => i === s).length;
  assert(occurrences === 1, `Skill ${s} must appear in exactly one category (found ${occurrences})`);
}

// 3. Uncategorized skills ('Agile', 'SpecialTool') fall back to 'Other'
const otherCategory = normalized.find(c => c.category === 'Other');
assert(otherCategory && otherCategory.items.includes('Agile') && otherCategory.items.includes('SpecialTool'), 'Uncategorized skills must fall back to "Other"');

// 4. Empty categories are omitted
assert(!normalized.some(c => c.category === 'Empty Category'), 'Empty categories must be omitted');

console.log(`\n🎉 ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!\n`);
