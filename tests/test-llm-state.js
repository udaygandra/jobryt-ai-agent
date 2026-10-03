const assert = require('assert');
const {
  WATERFALL,
  getLLMState,
  saveLLMState,
  getNextWaterfallModel,
  recordModelCall,
  recordModelError
} = require('../scripts/engine/llm-state-manager');

console.log('🧪 Testing User-Defined Waterfall & Quota Tracker...');

// Reset state for hermetic testing
const cleanState = {};
for (const m of WATERFALL) {
  cleanState[m.id] = { calls_today: 0, minute: [], blocked_until: 0, day: '2026-10-01', blacklisted: false };
}
saveLLMState(cleanState);

// Test 1: Verify all 10 models in waterfall
assert.strictEqual(WATERFALL.length, 10, 'Waterfall must have 10 models');
assert.strictEqual(WATERFALL[0].id, 'gemini-3.8-flash');
assert.strictEqual(WATERFALL[WATERFALL.length - 1].id, 'gemma-4-26b');
console.log('   ✅ Waterfall models configured correctly (10 models)');

// Test 2: Initial model selection
const { model: initialModel, waitMs: initWait } = getNextWaterfallModel(1000);
assert.strictEqual(initialModel.id, 'gemini-3.8-flash', 'First available model should be gemini-3.8-flash');
assert.strictEqual(initWait, 0, 'Initial wait should be 0');
console.log('   ✅ Initial model selection verified:', initialModel.id);

// Test 3: Record model calls and exhaust RPM (5 calls for gemini-3.8-flash)
for (let i = 0; i < 5; i++) {
  recordModelCall('gemini-3.8-flash');
}
const stateAfterCalls = getLLMState();
assert.strictEqual(stateAfterCalls['gemini-3.8-flash'].minute.length, 5, 'Should have 5 calls in sliding minute');
assert.strictEqual(stateAfterCalls['gemini-3.8-flash'].calls_today, 5, 'Should have 5 calls today');

// Now gemini-3.8-flash is at RPM limit (5), next model should be gemini-3.7-flash!
const { model: secondModel } = getNextWaterfallModel(1000);
assert.strictEqual(secondModel.id, 'gemini-3.7-flash', 'Should advance to gemini-3.7-flash when first model hits RPM');
console.log('   ✅ RPM rollover verified -> Switched to:', secondModel.id);

// Test 4: Record 429 Daily error
recordModelError('gemini-3.7-flash', new Error('HTTP 429: Resource exhausted per day'));
const stateAfterDaily = getLLMState();
assert.strictEqual(stateAfterDaily['gemini-3.7-flash'].calls_today, 20, 'Daily quota should be marked full');

const { model: thirdModel } = getNextWaterfallModel(1000);
assert.strictEqual(thirdModel.id, 'gemini-3.6-flash', 'Should advance past daily-exhausted model');
console.log('   ✅ Daily quota exhaustion verified -> Switched to:', thirdModel.id);

// Test 5: 404 Blacklist
recordModelError('gemini-3.6-flash', new Error('HTTP 404: Model not found'));
const { model: fourthModel } = getNextWaterfallModel(1000);
assert.strictEqual(fourthModel.id, 'gemini-3.5-flash', 'Should skip 404 blacklisted models');
console.log('   ✅ 404 Blacklisting verified -> Switched to:', fourthModel.id);

// Cleanup state after test
saveLLMState(cleanState);

console.log('🎉 ALL WATERFALL & RATE LIMIT TESTS PASSED!');
