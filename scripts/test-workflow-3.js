const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const csvFile = path.join(dataDir, 'dashboard.csv');

// Reset CSV for tests
fs.writeFileSync(csvFile, "Job Title,Company,Match %,ATS %,Status,Timestamp\n");

function mockHunter(domain) {
  return { contactName: "Jane Doe", email: `jane@${domain}` };
}

function mockGeminiDraft(contact, company) {
  return `Hi ${contact},\nI'd love to work at ${company}.\nThanks.`;
}

// Simulates the Wait node and Switch Router
function processJob(job, webhookPayload) {
  console.log(`\nProcessing Job: ${job.jobTitle} @ ${job.company}`);
  
  // 1 & 2. Mock Hunter & Gemini
  const contact = mockHunter(job.companyDomain);
  const emailDraft = mockGeminiDraft(contact.contactName, job.company);
  console.log(`Drafted email for ${contact.email}...`);

  // 3. Telegram Send (Simulated)
  console.log(`Sent to Telegram waiting for approval...`);

  // 4 & 5. Wait node receives webhook & Routes
  const action = webhookPayload.callback_query.data;
  let logStatus = "";
  
  if (action.startsWith("approve_")) {
    console.log("🟢 Webhook triggered: APPROVE");
    // 6. Send Gmail (Simulated)
    console.log(`✉️ Email SENT to ${contact.email}`);
    logStatus = "SENT";
  } else if (action.startsWith("reject_")) {
    console.log("🔴 Webhook triggered: REJECT");
    console.log("❌ Email DROPPED");
    logStatus = "REJECTED";
  } else {
    throw new Error("Invalid Webhook Route");
  }

  // 7. Write to CSV
  const csvLine = `${job.jobTitle},${job.company},${job.matchPct},${job.atsPct},${logStatus},${new Date().toISOString()}\n`;
  fs.appendFileSync(csvFile, csvLine);
}

// Run Tests
function runTests() {
  console.log("=== Starting Workflow 3 Integration Test ===");
  
  const job1 = {
    jobId: "123", jobTitle: "Data Analyst", company: "TechCorp", 
    companyDomain: "techcorp.com", matchPct: 95, atsPct: 80
  };
  
  const job2 = {
    jobId: "456", jobTitle: "Senior Analyst", company: "DataCo", 
    companyDomain: "dataco.com", matchPct: 70, atsPct: 75
  };

  // Test 1: Approval Route
  const approveWebhook = { callback_query: { data: "approve_123" } };
  processJob(job1, approveWebhook);

  // Test 2: Reject Route
  const rejectWebhook = { callback_query: { data: "reject_456" } };
  processJob(job2, rejectWebhook);

  // Verify Log
  const csvData = fs.readFileSync(csvFile, 'utf8');
  console.log("\n--- CSV LOG OUTPUT ---");
  console.log(csvData.trim());
  
  if (!csvData.includes("TechCorp,95,80,SENT")) throw new Error("Approval log failed");
  if (!csvData.includes("DataCo,70,75,REJECTED")) throw new Error("Rejection log failed");
  
  console.log("✅ All Integration Tests Passed Successfully!");
}

runTests();
