/**
 * benchmark-25-roles.js
 * Comprehensive Verification Benchmark for 25 Diverse Candidate Roles across:
 * - Experience tiers (Junior, Mid-level, Senior IC, Lead/Principal, Manager, Executive VP/Director)
 * - Diverse professions (Data, Software, Product, Healthcare, Finance, HR, DevOps, Marketing, Sales, Operations, Security)
 * - Diverse locations (Toronto, Vancouver, Montreal, Calgary, New York, Austin, SF, Seattle, Chicago, Remote US/CA)
 * - Work types (Remote Only, Hybrid & Remote, Open to All)
 */

const {
  isJobRoleRelevant,
  isJobLocationEligible,
  isJobWorkplaceEligible,
  detectTargetCountryScope
} = require('../scripts/core/geo-helper');

const PERSONAS = [
  {
    id: 1,
    title: 'Junior Data Analyst',
    target_titles: ['Junior Data Analyst', 'Associate Data Analyst', 'Data Analytics Intern', 'Reporting Analyst'],
    locations: ['Toronto, ON, Canada'],
    work_type: 'Remote Only',
    test_jobs: [
      { title: 'Junior Data Analyst', loc: 'Toronto (Remote)', type: 'remote', expected: true },
      { title: 'Associate Reporting Analyst', loc: 'Canada (Remote)', type: 'remote', expected: true },
      { title: 'Data Analytics Intern', loc: 'Toronto, Ontario', type: 'remote', expected: true },
      { title: 'Senior Data Architect', loc: 'Toronto, Ontario', type: 'onsite', expected: false },
      { title: 'Senior Recruiter', loc: 'Remote', type: 'remote', expected: false },
      { title: 'Shopify Developer', loc: 'Remote', type: 'remote', expected: false }
    ]
  },
  {
    id: 2,
    title: 'Senior Machine Learning / AI Engineer',
    target_titles: ['Senior Machine Learning Engineer', 'Senior AI Engineer', 'Lead MLOps Engineer', 'AI Research Scientist'],
    locations: ['Vancouver, BC, Canada'],
    work_type: 'Hybrid & Remote',
    test_jobs: [
      { title: 'Senior Machine Learning Engineer', loc: 'Vancouver, BC', type: 'hybrid', expected: true },
      { title: 'Senior AI Engineer - Computer Vision', loc: 'Vancouver (Remote)', type: 'remote', expected: true },
      { title: 'Lead MLOps Specialist', loc: 'British Columbia', type: 'hybrid', expected: true },
      { title: 'Junior Web Developer', loc: 'Vancouver, BC', type: 'hybrid', expected: false },
      { title: 'Senior Financial Accountant', loc: 'Vancouver, BC', type: 'hybrid', expected: false },
      { title: 'Registered Nurse', loc: 'Vancouver, BC', type: 'onsite', expected: false }
    ]
  },
  {
    id: 3,
    title: 'Staff Full Stack Software Engineer',
    target_titles: ['Staff Software Engineer', 'Principal Full Stack Engineer', 'Lead Developer', 'Staff Fullstack Developer'],
    locations: ['Austin, TX, USA'],
    work_type: 'Remote Only',
    test_jobs: [
      { title: 'Staff Software Engineer', loc: 'Austin, TX (Remote)', type: 'remote', expected: true },
      { title: 'Principal Full Stack Engineer - React & Node', loc: 'USA (Remote)', type: 'remote', expected: true },
      { title: 'Lead Developer, Core Platform', loc: 'Texas (Remote)', type: 'remote', expected: true },
      { title: 'Junior Frontend Intern', loc: 'Austin, TX', type: 'onsite', expected: false },
      { title: 'Technical Recruiter', loc: 'Remote', type: 'remote', expected: false },
      { title: 'VP of Global Sales', loc: 'Austin, TX', type: 'remote', expected: false }
    ]
  },
  {
    id: 4,
    title: 'Mid-level Backend Engineer',
    target_titles: ['Backend Engineer', 'Python Developer', 'Go Developer', 'Cloud Backend Developer'],
    locations: ['New York, NY, USA'],
    work_type: 'Hybrid & Remote',
    test_jobs: [
      { title: 'Backend Software Engineer - Distributed Systems', loc: 'New York, NY', type: 'hybrid', expected: true },
      { title: 'Python Backend Developer', loc: 'New York (Remote)', type: 'remote', expected: true },
      { title: 'Cloud Backend Developer (Go / Kubernetes)', loc: 'New York, NY', type: 'hybrid', expected: true },
      { title: 'Senior Director of Marketing', loc: 'New York, NY', type: 'hybrid', expected: false },
      { title: 'Registered ICU Nurse', loc: 'New York, NY', type: 'onsite', expected: false },
      { title: 'Junior Bookkeeper', loc: 'New York, NY', type: 'onsite', expected: false }
    ]
  },
  {
    id: 5,
    title: 'Frontend Developer',
    target_titles: ['Frontend Developer', 'React Developer', 'UI Engineer', 'Web Application Developer'],
    locations: ['Montreal, QC, Canada'],
    work_type: 'Remote Only',
    test_jobs: [
      { title: 'Senior Frontend Developer', loc: 'Montreal (Remote)', type: 'remote', expected: true },
      { title: 'React Web Developer', loc: 'Quebec (Remote)', type: 'remote', expected: true },
      { title: 'UI Engineer - Design Systems', loc: 'Canada (Remote)', type: 'remote', expected: true },
      { title: 'Database Administrator', loc: 'Montreal, QC', type: 'onsite', expected: false },
      { title: 'Senior Recruiter', loc: 'Montreal, QC', type: 'remote', expected: false },
      { title: 'VP of Operations', loc: 'Montreal, QC', type: 'remote', expected: false }
    ]
  },
  {
    id: 6,
    title: 'Senior DevOps / SRE Engineer',
    target_titles: ['Senior DevOps Engineer', 'Site Reliability Engineer', 'SRE', 'Cloud Infrastructure Engineer'],
    locations: ['Calgary, AB, Canada'],
    work_type: 'Open to All',
    test_jobs: [
      { title: 'Senior DevOps Engineer', loc: 'Calgary, Alberta', type: 'onsite', expected: true },
      { title: 'Site Reliability Engineer (SRE)', loc: 'Calgary (Remote)', type: 'remote', expected: true },
      { title: 'Cloud Infrastructure Engineer - Terraform / AWS', loc: 'Calgary, AB', type: 'hybrid', expected: true },
      { title: 'Clinical Care Nurse', loc: 'Calgary, AB', type: 'onsite', expected: false },
      { title: 'Senior Recruiter', loc: 'Calgary, AB', type: 'remote', expected: false },
      { title: 'Content Writer', loc: 'Calgary, AB', type: 'remote', expected: false }
    ]
  },
  {
    id: 7,
    title: 'Mobile Engineer (iOS / Android)',
    target_titles: ['iOS Developer', 'Android Developer', 'Mobile Software Engineer', 'Flutter Developer'],
    locations: ['San Francisco, CA, USA'],
    work_type: 'Remote Only',
    test_jobs: [
      { title: 'Senior iOS Developer', loc: 'San Francisco, CA (Remote)', type: 'remote', expected: true },
      { title: 'Android Mobile Software Engineer', loc: 'USA (Remote)', type: 'remote', expected: true },
      { title: 'Flutter Developer - Mobile Apps', loc: 'California (Remote)', type: 'remote', expected: true },
      { title: 'Senior Financial Analyst', loc: 'San Francisco, CA', type: 'onsite', expected: false },
      { title: 'Technical Recruiter', loc: 'San Francisco, CA', type: 'remote', expected: false },
      { title: 'Data Entry Clerk', loc: 'San Francisco, CA', type: 'onsite', expected: false }
    ]
  },
  {
    id: 8,
    title: 'Principal Product Manager',
    target_titles: ['Principal Product Manager', 'Group Product Manager', 'Lead Technical Product Manager'],
    locations: ['Seattle, WA, USA'],
    work_type: 'Hybrid & Remote',
    test_jobs: [
      { title: 'Principal Product Manager - Cloud Services', loc: 'Seattle, WA', type: 'hybrid', expected: true },
      { title: 'Group Product Manager - Enterprise Platform', loc: 'Seattle, WA (Remote)', type: 'remote', expected: true },
      { title: 'Lead Technical Product Manager', loc: 'Washington State', type: 'hybrid', expected: true },
      { title: 'Junior QA Tester', loc: 'Seattle, WA', type: 'onsite', expected: false },
      { title: 'Senior Accountant', loc: 'Seattle, WA', type: 'hybrid', expected: false },
      { title: 'Registered Nurse', loc: 'Seattle, WA', type: 'onsite', expected: false }
    ]
  },
  {
    id: 9,
    title: 'Associate Product Manager',
    target_titles: ['Associate Product Manager', 'Junior Product Owner', 'Product Operations Analyst', 'Product Analyst'],
    locations: ['Ottawa, ON, Canada'],
    work_type: 'Open to All',
    test_jobs: [
      { title: 'Associate Product Manager', loc: 'Ottawa, Ontario', type: 'onsite', expected: true },
      { title: 'Junior Product Owner - Digital Experiences', loc: 'Ottawa, ON', type: 'hybrid', expected: true },
      { title: 'Product Operations Analyst', loc: 'Ottawa, ON', type: 'remote', expected: true },
      { title: 'VP of Product Management', loc: 'Ottawa, ON', type: 'onsite', expected: false },
      { title: 'Senior Solutions Architect', loc: 'Ottawa, ON', type: 'onsite', expected: false },
      { title: 'Recruiting Coordinator', loc: 'Ottawa, ON', type: 'onsite', expected: false }
    ]
  },
  {
    id: 10,
    title: 'Senior UI/UX Product Designer',
    target_titles: ['Senior UI/UX Designer', 'Product Designer', 'User Experience Specialist', 'Lead UX Researcher'],
    locations: ['Chicago, IL, USA'],
    work_type: 'Remote Only',
    test_jobs: [
      { title: 'Senior UI/UX Designer', loc: 'Chicago, IL (Remote)', type: 'remote', expected: true },
      { title: 'Product Designer - Mobile & Web', loc: 'USA (Remote)', type: 'remote', expected: true },
      { title: 'User Experience Specialist', loc: 'Illinois (Remote)', type: 'remote', expected: true },
      { title: 'C++ Firmware Developer', loc: 'Chicago, IL', type: 'onsite', expected: false },
      { title: 'Corporate Accountant', loc: 'Chicago, IL', type: 'onsite', expected: false },
      { title: 'Medical Assistant', loc: 'Chicago, IL', type: 'onsite', expected: false }
    ]
  },
  {
    id: 11,
    title: 'QA Automation Engineer (SDET)',
    target_titles: ['QA Automation Engineer', 'Software Development Engineer in Test', 'SDET', 'Test Automation Engineer'],
    locations: ['Toronto, ON, Canada'],
    work_type: 'Hybrid & Remote',
    test_jobs: [
      { title: 'Senior QA Automation Engineer', loc: 'Toronto, Ontario', type: 'hybrid', expected: true },
      { title: 'Software Development Engineer in Test (SDET)', loc: 'Toronto (Remote)', type: 'remote', expected: true },
      { title: 'Test Automation Specialist - Playwright & Cypress', loc: 'GTA, Ontario', type: 'hybrid', expected: true },
      { title: 'Senior Recruiter', loc: 'Toronto, ON', type: 'remote', expected: false },
      { title: 'Shopify Developer', loc: 'Toronto, ON', type: 'remote', expected: false },
      { title: 'Account Executive', loc: 'Toronto, ON', type: 'hybrid', expected: false }
    ]
  },
  {
    id: 12,
    title: 'Cybersecurity & InfoSec Analyst',
    target_titles: ['Information Security Analyst', 'Cybersecurity Specialist', 'SOC Analyst', 'Security Engineer'],
    locations: ['Toronto, ON, Canada'],
    work_type: 'Open to All',
    test_jobs: [
      { title: 'Information Security Analyst II', loc: 'Toronto, ON', type: 'onsite', expected: true },
      { title: 'Cybersecurity Specialist - Incident Response', loc: 'Toronto (Remote)', type: 'remote', expected: true },
      { title: 'SOC Analyst - Threat Intelligence', loc: 'Ontario', type: 'hybrid', expected: true },
      { title: 'Social Media Manager', loc: 'Toronto, ON', type: 'remote', expected: false },
      { title: 'Travel Nurse', loc: 'Toronto, ON', type: 'onsite', expected: false },
      { title: 'Data Entry Clerk', loc: 'Toronto, ON', type: 'onsite', expected: false }
    ]
  },
  {
    id: 13,
    title: 'Registered Nurse / Clinical Specialist',
    target_titles: ['Registered Nurse', 'Clinical Nurse Specialist', 'Nurse Supervisor', 'Staff Nurse'],
    locations: ['Edmonton, AB, Canada'],
    work_type: 'Open to All',
    test_jobs: [
      { title: 'Staff Nurse - Intensive Care Unit', loc: 'Edmonton, Alberta', type: 'onsite', expected: true },
      { title: 'Registered Nurse (ER)', loc: 'Edmonton, AB', type: 'onsite', expected: true },
      { title: 'Clinical Nurse Specialist', loc: 'Alberta', type: 'onsite', expected: true },
      { title: 'Full Stack Software Engineer', loc: 'Edmonton, AB', type: 'remote', expected: false },
      { title: 'Senior Recruiter', loc: 'Edmonton, AB', type: 'remote', expected: false },
      { title: 'Data Analyst', loc: 'Edmonton, AB', type: 'remote', expected: false }
    ]
  },
  {
    id: 14,
    title: 'Senior Financial Analyst (FP&A)',
    target_titles: ['Senior Financial Analyst', 'Financial Planning & Analysis Specialist', 'FP&A Analyst', 'Corporate Finance Associate'],
    locations: ['New York, NY, USA'],
    work_type: 'Hybrid & Remote',
    test_jobs: [
      { title: 'Senior Financial Analyst - Corporate FP&A', loc: 'New York, NY', type: 'hybrid', expected: true },
      { title: 'FP&A Financial Analyst', loc: 'New York (Remote)', type: 'remote', expected: true },
      { title: 'Financial Planning & Analysis Specialist', loc: 'New York, NY', type: 'hybrid', expected: true },
      { title: 'React Frontend Developer', loc: 'New York, NY', type: 'remote', expected: false },
      { title: 'Registered Nurse', loc: 'New York, NY', type: 'onsite', expected: false },
      { title: 'Warehouse Associate', loc: 'New York, NY', type: 'onsite', expected: false }
    ]
  },
  {
    id: 15,
    title: 'Accounting Manager / CPA',
    target_titles: ['Accounting Manager', 'Senior Accountant', 'Corporate Controller', 'CPA Specialist'],
    locations: ['Toronto, ON, Canada'],
    work_type: 'Hybrid & Remote',
    test_jobs: [
      { title: 'Accounting Manager - General Ledger', loc: 'Toronto, Ontario', type: 'hybrid', expected: true },
      { title: 'Senior Accountant - Audit & Tax', loc: 'Toronto, ON', type: 'hybrid', expected: true },
      { title: 'Corporate Controller', loc: 'Toronto (Remote)', type: 'remote', expected: true },
      { title: 'iOS App Developer', loc: 'Toronto, ON', type: 'remote', expected: false },
      { title: 'DevOps Engineer', loc: 'Toronto, ON', type: 'remote', expected: false },
      { title: 'UI Graphic Designer', loc: 'Toronto, ON', type: 'remote', expected: false }
    ]
  },
  {
    id: 16,
    title: 'Senior Technical Recruiter',
    target_titles: ['Senior Technical Recruiter', 'Talent Acquisition Partner', 'Senior Talent Sourcer', 'Recruiting Lead'],
    locations: ['Austin, TX, USA'],
    work_type: 'Remote Only',
    test_jobs: [
      { title: 'Senior Technical Recruiter - Tech & Engineering', loc: 'Austin, TX (Remote)', type: 'remote', expected: true },
      { title: 'Talent Acquisition Partner', loc: 'USA (Remote)', type: 'remote', expected: true },
      { title: 'Recruiting Lead - GTM', loc: 'Texas (Remote)', type: 'remote', expected: true },
      { title: 'Database Administrator', loc: 'Austin, TX', type: 'onsite', expected: false },
      { title: 'Financial Analyst', loc: 'Austin, TX', type: 'hybrid', expected: false },
      { title: 'Staff Nurse', loc: 'Austin, TX', type: 'onsite', expected: false }
    ]
  },
  {
    id: 17,
    title: 'HR Business Partner (HRBP)',
    target_titles: ['HR Business Partner', 'People Operations Manager', 'HR Generalist', 'People Partner'],
    locations: ['Vancouver, BC, Canada'],
    work_type: 'Hybrid & Remote',
    test_jobs: [
      { title: 'Senior HR Business Partner (HRBP)', loc: 'Vancouver, BC', type: 'hybrid', expected: true },
      { title: 'People Operations Manager', loc: 'Vancouver (Remote)', type: 'remote', expected: true },
      { title: 'People Partner - Tech & Operations', loc: 'British Columbia', type: 'hybrid', expected: true },
      { title: 'Golang Engineer', loc: 'Vancouver, BC', type: 'remote', expected: false },
      { title: 'Dental Assistant', loc: 'Vancouver, BC', type: 'onsite', expected: false },
      { title: 'Database Administrator', loc: 'Vancouver, BC', type: 'onsite', expected: false }
    ]
  },
  {
    id: 18,
    title: 'Supply Chain & Logistics Manager',
    target_titles: ['Supply Chain Manager', 'Logistics Operations Lead', 'Procurement Specialist', 'Materials Manager'],
    locations: ['Calgary, AB, Canada'],
    work_type: 'Open to All',
    test_jobs: [
      { title: 'Supply Chain Operations Manager', loc: 'Calgary, Alberta', type: 'onsite', expected: true },
      { title: 'Procurement Specialist - Strategic Sourcing', loc: 'Calgary, AB', type: 'hybrid', expected: true },
      { title: 'Logistics Operations Lead', loc: 'Calgary, AB', type: 'onsite', expected: true },
      { title: 'Frontend React Developer', loc: 'Calgary, AB', type: 'remote', expected: false },
      { title: 'Clinical Psychologist', loc: 'Calgary, AB', type: 'onsite', expected: false },
      { title: 'iOS Software Engineer', loc: 'Calgary, AB', type: 'remote', expected: false }
    ]
  },
  {
    id: 19,
    title: 'Enterprise Account Executive (B2B SaaS)',
    target_titles: ['Enterprise Account Executive', 'Senior Sales Representative', 'Strategic Account Manager', 'B2B SaaS Sales Executive'],
    locations: ['New York, NY, USA'],
    work_type: 'Remote Only',
    test_jobs: [
      { title: 'Enterprise Account Executive - SaaS Platforms', loc: 'New York (Remote)', type: 'remote', expected: true },
      { title: 'Senior Sales Representative - Cloud Security', loc: 'USA (Remote)', type: 'remote', expected: true },
      { title: 'Strategic Account Manager', loc: 'New York (Remote)', type: 'remote', expected: true },
      { title: 'DevOps Engineer', loc: 'New York, NY', type: 'remote', expected: false },
      { title: 'Data Scientist', loc: 'New York, NY', type: 'remote', expected: false },
      { title: 'Accounting Clerk', loc: 'New York, NY', type: 'onsite', expected: false }
    ]
  },
  {
    id: 20,
    title: 'Digital Growth Marketing Manager',
    target_titles: ['Growth Marketing Manager', 'Digital Marketing Specialist', 'Performance Marketing Lead', 'Demand Generation Manager'],
    locations: ['Toronto, ON, Canada'],
    work_type: 'Remote Only',
    test_jobs: [
      { title: 'Senior Growth Marketing Manager', loc: 'Toronto (Remote)', type: 'remote', expected: true },
      { title: 'Performance Marketing Lead - Paid Media', loc: 'Canada (Remote)', type: 'remote', expected: true },
      { title: 'Digital Marketing Specialist', loc: 'Ontario (Remote)', type: 'remote', expected: true },
      { title: 'Staff Nurse', loc: 'Toronto, ON', type: 'onsite', expected: false },
      { title: 'Embedded C++ Developer', loc: 'Toronto, ON', type: 'onsite', expected: false },
      { title: 'Security Guard', loc: 'Toronto, ON', type: 'onsite', expected: false }
    ]
  },
  {
    id: 21,
    title: 'Agile Scrum Master / Technical PM',
    target_titles: ['Scrum Master', 'Agile Project Manager', 'Technical Program Manager', 'Delivery Lead'],
    locations: ['Calgary, AB, Canada'],
    work_type: 'Hybrid & Remote',
    test_jobs: [
      { title: 'Senior Scrum Master - Cloud Initiatives', loc: 'Calgary, AB', type: 'hybrid', expected: true },
      { title: 'Agile Project Manager', loc: 'Calgary (Remote)', type: 'remote', expected: true },
      { title: 'Technical Program Manager', loc: 'Alberta', type: 'hybrid', expected: true },
      { title: 'Shopify Developer', loc: 'Calgary, AB', type: 'remote', expected: false },
      { title: 'Recruiting Coordinator', loc: 'Calgary, AB', type: 'remote', expected: false },
      { title: 'Dental Hygienist', loc: 'Calgary, AB', type: 'onsite', expected: false }
    ]
  },
  {
    id: 22,
    title: 'Enterprise Solutions Architect',
    target_titles: ['Enterprise Architect', 'Principal Solutions Architect', 'Cloud Solutions Architect', 'Chief Architect'],
    locations: ['Austin, TX, USA'],
    work_type: 'Remote Only',
    test_jobs: [
      { title: 'Principal Solutions Architect - AWS Cloud', loc: 'Austin, TX (Remote)', type: 'remote', expected: true },
      { title: 'Enterprise Architect - Systems Integration', loc: 'USA (Remote)', type: 'remote', expected: true },
      { title: 'Cloud Solutions Architect', loc: 'Texas (Remote)', type: 'remote', expected: true },
      { title: 'Junior Web Intern', loc: 'Austin, TX', type: 'onsite', expected: false },
      { title: 'Customer Support Representative', loc: 'Austin, TX', type: 'remote', expected: false },
      { title: 'Bank Teller', loc: 'Austin, TX', type: 'onsite', expected: false }
    ]
  },
  {
    id: 23,
    title: 'Senior Database Administrator (DBA)',
    target_titles: ['Database Administrator', 'Senior DBA', 'PostgreSQL Database Engineer', 'SQL Server DBA'],
    locations: ['Halifax, NS, Canada'],
    work_type: 'Open to All',
    test_jobs: [
      { title: 'Senior PostgreSQL Database Administrator', loc: 'Halifax, Nova Scotia', type: 'hybrid', expected: true },
      { title: 'SQL Server DBA Specialist', loc: 'Halifax, NS', type: 'onsite', expected: true },
      { title: 'Senior Database Administrator (Azure)', loc: 'Canada (Remote)', type: 'remote', expected: true },
      { title: 'Senior Recruiter', loc: 'Halifax, NS', type: 'remote', expected: false },
      { title: 'B2B Sales Representative', loc: 'Halifax, NS', type: 'hybrid', expected: false },
      { title: 'Fashion Designer', loc: 'Halifax, NS', type: 'onsite', expected: false }
    ]
  },
  {
    id: 24,
    title: 'VP of Software Engineering',
    target_titles: ['VP of Engineering', 'Vice President of Software Engineering', 'Director of Engineering', 'Head of Technology'],
    locations: ['San Francisco, CA, USA'],
    work_type: 'Hybrid & Remote',
    test_jobs: [
      { title: 'VP of Engineering - Cloud Platform', loc: 'San Francisco, CA', type: 'hybrid', expected: true },
      { title: 'Director of Software Engineering', loc: 'San Francisco (Remote)', type: 'remote', expected: true },
      { title: 'Head of Technology', loc: 'California', type: 'hybrid', expected: true },
      { title: 'Junior React Intern', loc: 'San Francisco, CA', type: 'onsite', expected: false },
      { title: 'Associate Recruiter', loc: 'San Francisco, CA', type: 'remote', expected: false },
      { title: 'Helpdesk Technician', loc: 'San Francisco, CA', type: 'onsite', expected: false }
    ]
  },
  {
    id: 25,
    title: 'Business Operations & Strategy Manager',
    target_titles: ['Business Operations Manager', 'Strategy & Operations Lead', 'BizOps Specialist', 'Chief of Staff'],
    locations: ['New York, NY, USA'],
    work_type: 'Hybrid & Remote',
    test_jobs: [
      { title: 'Business Operations Manager', loc: 'New York, NY', type: 'hybrid', expected: true },
      { title: 'Strategy & Operations Lead', loc: 'New York (Remote)', type: 'remote', expected: true },
      { title: 'BizOps Specialist - Corporate Strategy', loc: 'New York, NY', type: 'hybrid', expected: true },
      { title: 'iOS Mobile Developer', loc: 'New York, NY', type: 'remote', expected: false },
      { title: 'Registered Scrub Nurse', loc: 'New York, NY', type: 'onsite', expected: false },
      { title: 'Junior QA Tester', loc: 'New York, NY', type: 'onsite', expected: false }
    ]
  }
];

// Run the benchmark
console.log('🚀 Running Benchmark across 25 Diverse Candidate Personas...\n');

let totalTests = 0;
let passedTests = 0;

PERSONAS.forEach(persona => {
  console.log(`Candidate ${persona.id}: "${persona.title}"`);
  console.log(`   Scope: ${persona.locations[0]} | Mode: ${persona.work_type}`);
  
  const scope = detectTargetCountryScope(persona.locations);
  let personaPassed = 0;

  persona.test_jobs.forEach(job => {
    totalTests++;
    const roleMatch = isJobRoleRelevant(job.title, persona.target_titles);
    const locMatch = isJobLocationEligible(job.loc, persona.locations, scope, job.type === 'remote');
    const workMatch = isJobWorkplaceEligible(job.loc, '', job.title, persona.work_type, job.type === 'remote');
    
    const overallAdmitted = roleMatch && locMatch && workMatch;
    const isCorrect = (overallAdmitted === job.expected);

    if (isCorrect) {
      passedTests++;
      personaPassed++;
      console.log(`      ✔ [${job.expected ? 'ADMITTED' : 'REJECTED'}] "${job.title}" (${job.loc})`);
    } else {
      console.log(`      ❌ MISMATCH on "${job.title}" (${job.loc}): Expected ${job.expected}, got ${overallAdmitted} (role=${roleMatch}, loc=${locMatch}, work=${workMatch})`);
    }
  });

  const personaScore = Math.round((personaPassed / persona.test_jobs.length) * 100);
  console.log(`   --> Accuracy: ${personaScore}% (${personaPassed}/${persona.test_jobs.length})\n`);
});

const overallAccuracy = Math.round((passedTests / totalTests) * 100);
console.log('====================================================');
console.log(`🏁 FINAL BENCHMARK RESULT: ${overallAccuracy}% Accuracy (${passedTests}/${totalTests} tests passed)`);
console.log('====================================================');

process.exit(overallAccuracy >= 90 ? 0 : 1);
