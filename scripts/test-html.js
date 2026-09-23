const fs = require('fs');

try {
  const jobs = JSON.parse(fs.readFileSync('./data/processed_jobs.json', 'utf8'));
  const item = { json: jobs[0] };
  
  let profile = {};
  try { profile = JSON.parse(fs.readFileSync('./data/master-profile.json', 'utf8')); } catch(e) {}
  
  const name = profile.name || 'Professional Candidate';
  const email = profile.contact && profile.contact.email ? profile.contact.email : '';
  const phone = profile.contact && profile.contact.phone ? profile.contact.phone : '';
  const location = profile.locations && profile.locations.length > 0 ? profile.locations[0] : '';
  const title = profile.target_titles && profile.target_titles.length > 0 ? profile.target_titles[0] : '';
  
  let bullets = [
    "Engineered time-based analytical features, including peak-hour flags, lag variables, and rolling averages to support time-series analysis and downstream forecasting.",
    "Built interactive Power BI dashboards using Power Query, DAX measures, and comparative visualizations to monitor market conditions.",
    "Wrote complex SQL queries using CTEs, window functions, and multi-table joins to extract and validate data, reducing manual preparation time by over 8 hours per week."
  ];
  
  let bulletsHtml = bullets.map(b => `<li style="margin-bottom: 12px;">${b.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</li>`).join('\\n');
  let contentHtml = `
    <div class="section">
      <h3 class="section-title">TAILORED EXPERIENCE</h3>
      <ul>
        ${bulletsHtml}
      </ul>
    </div>
  `;
  
  const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');
  body { font-family: 'Inter', sans-serif; color: #1f2937; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; }
  .container { max-width: 800px; margin: 0 auto; padding: 40px; }
  .header { text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px; }
  .name { font-size: 36px; font-weight: 700; color: #111827; margin: 0 0 5px 0; letter-spacing: 1px; text-transform: uppercase; }
  .title { font-size: 18px; color: #4b5563; font-weight: 600; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 2px; }
  .contact-info { font-size: 13px; color: #6b7280; }
  .contact-info span { margin: 0 8px; }
  .section { margin-top: 25px; }
  .section-title { font-size: 16px; color: #2563eb; text-transform: uppercase; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; margin-bottom: 15px; }
  .content { font-size: 14px; }
  ul { padding-left: 20px; margin: 0; }
  strong { color: #111827; }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="name">${name}</h1>
      <h2 class="title">${title}</h2>
      <div class="contact-info">
        <span>${email}</span> | <span>${phone}</span> | <span>${location}</span>
      </div>
    </div>
    <div class="content">${contentHtml}</div>
  </div>
</body>
</html>`;
  
  fs.writeFileSync('./data/hydrated.html', htmlTemplate);
  console.log("HTML generated at ./data/hydrated.html");

} catch (error) {
  console.error("Error:", error);
}
