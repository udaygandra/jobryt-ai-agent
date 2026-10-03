const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

function buildFullDepthResumePdf({
  profile,
  targetRole,
  companyName,
  tailoredSummary,
  categorizedSkills,
  tailoredExperience,
  outputPath
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 36, bottom: 36, left: 36, right: 36 },
      bufferPages: true,
      autoFirstPage: true
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // Color Palette
    const primaryColor = '#1d4ed8'; // Crisp Deep Blue
    const darkColor = '#111827';    // Deep Charcoal for body text
    const grayColor = '#4b5563';    // Slate Gray for subtitles & dates
    const lightBorder = '#cbd5e1';  // Subtle divider lines

    // Helper: Page Break Protection
    function checkPageBreak(neededSpace = 50) {
      if (doc.y + neededSpace > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
    }

    // 1. HEADER
    const candidateName = profile.name || 'Candidate';
    doc.font('Helvetica-Bold')
       .fontSize(20)
       .fillColor(darkColor)
       .text(candidateName.toUpperCase(), { align: 'center', characterSpacing: 1 });

    // Lock candidate header profession to their authentic verified target title from profile
    const candidateProfession = (profile.target_titles && profile.target_titles[0]) || profile.profession || 'Professional';
    doc.font('Helvetica-Bold')
       .fontSize(10.5)
       .fillColor(primaryColor)
       .moveDown(0.15)
       .text(candidateProfession.toUpperCase(), { align: 'center', characterSpacing: 1.2 });

    // Contact Information
    const contact = profile.contact || {};
    const contactParts = [];
    if (contact.email) contactParts.push(contact.email);
    if (contact.phone) contactParts.push(contact.phone);
    if (profile.locations && profile.locations.length > 0) contactParts.push(profile.locations[0]);
    if (contact.status) contactParts.push(contact.status);

    doc.font('Helvetica')
       .fontSize(8.5)
       .fillColor(grayColor)
       .moveDown(0.25)
       .text(contactParts.join('   |   '), { align: 'center' });

    doc.moveDown(0.4);

    // Section Header Helper
    function addSectionHeader(title) {
      checkPageBreak(40);
      doc.moveDown(0.35);
      doc.font('Helvetica-Bold')
         .fontSize(10)
         .fillColor(primaryColor)
         .text(title.toUpperCase(), { characterSpacing: 0.8 });

      const y = doc.y + 2;
      doc.strokeColor(lightBorder)
         .lineWidth(0.75)
         .moveTo(doc.page.margins.left, y)
         .lineTo(doc.page.width - doc.page.margins.right, y)
         .stroke();
      doc.moveDown(0.3);
    }

    // 2. PROFESSIONAL SUMMARY
    addSectionHeader('Professional Summary');
    const summaryText = tailoredSummary || profile.summary || '';
    doc.font('Helvetica')
       .fontSize(9)
       .fillColor(darkColor)
       .text(summaryText, { lineGap: 2, align: 'justify' });

    // 3. CORE COMPETENCIES & SKILLS
    addSectionHeader('Core Competencies & Skills');

    function parseSkillGroups(input, fallbackSkills = []) {
      const groups = {};

      const addItems = (label, list) => {
        if (!label || !Array.isArray(list) || list.length === 0) return;
        const cleanLabel = String(label).trim();
        const cleanList = list.map(s => typeof s === 'string' ? s.trim() : (s?.name || String(s))).filter(Boolean);
        if (cleanList.length > 0) {
          groups[cleanLabel] = (groups[cleanLabel] || []).concat(cleanList);
        }
      };

      if (Array.isArray(input)) {
        for (const item of input) {
          if (typeof item === 'string') {
            addItems('Core Competencies', [item]);
          } else if (item && typeof item === 'object') {
            const label = item.category || item.name || item.group || item.title || 'Core Competencies';
            const list = Array.isArray(item.items) ? item.items : (Array.isArray(item.skills) ? item.skills : []);
            addItems(label, list);
          }
        }
      } else if (input && typeof input === 'object') {
        for (const [key, val] of Object.entries(input)) {
          if (Array.isArray(val)) {
            addItems(key, val);
          } else if (typeof val === 'string') {
            addItems(key, [val]);
          } else if (val && typeof val === 'object') {
            const label = val.category || val.name || key;
            const list = Array.isArray(val.items) ? val.items : (Array.isArray(val.skills) ? val.skills : []);
            addItems(label, list);
          }
        }
      }

      if (Object.keys(groups).length === 0 && Array.isArray(fallbackSkills) && fallbackSkills.length > 0) {
        addItems('Core Competencies & Technical Skills', fallbackSkills);
      }

      return groups;
    }

    const skillGroups = parseSkillGroups(categorizedSkills || profile.skills_categorized, profile.skills);

    for (const [groupLabel, skills] of Object.entries(skillGroups)) {
      checkPageBreak(18);
      const uniqueSkills = [...new Set(skills)];
      const skillList = uniqueSkills.join(', ');
      doc.font('Helvetica-Bold')
         .fontSize(8.5)
         .fillColor(darkColor)
         .text(`${groupLabel}: `, { continued: true })
         .font('Helvetica')
         .fillColor(grayColor)
         .text(skillList, { lineGap: 1.5 });
    }

    // 4. PROFESSIONAL EXPERIENCE
    addSectionHeader('Professional Experience');
    const experiences = (Array.isArray(tailoredExperience) && tailoredExperience.length > 0)
      ? tailoredExperience
      : (profile.experience || []);

    experiences.forEach((exp, expIdx) => {
      checkPageBreak(50);
      if (expIdx > 0) doc.moveDown(0.3);

      // Strictly lock role title and company to candidate's verified profile experience
      const origExp = (profile.experience && profile.experience[expIdx]) || {};
      const verifiedRole = exp.role || origExp.role || 'Role';
      const verifiedCompany = exp.company || origExp.company || 'Company';
      const verifiedDates = origExp.dates || exp.dates || '';

      // Role and Dates header line
      doc.font('Helvetica-Bold')
         .fontSize(9.5)
         .fillColor(darkColor)
         .text(verifiedRole, { continued: true })
         .font('Helvetica-Bold')
         .fillColor(primaryColor)
         .text(` — ${verifiedCompany}`, { continued: true })
         .font('Helvetica')
         .fillColor(grayColor)
         .text(`   |   ${verifiedDates}`, { align: 'right' });

      doc.moveDown(0.15);

      const bullets = exp.bullets || [];
      for (const bullet of bullets) {
        const cleanBullet = bullet.replace(/\*\*(.*?)\*\*/g, '$1').trim();
        doc.font('Helvetica')
           .fontSize(8.5)
           .fillColor(darkColor)
           .text('•  ', { indent: 6, continued: true })
           .text(cleanBullet, { lineGap: 1.5, indent: 6, align: 'left' });
        doc.moveDown(0.08);
      }
    });

    // 5. EDUCATION & CERTIFICATIONS
    addSectionHeader('Education & Certifications');
    const education = Array.isArray(profile.education) ? profile.education : [];
    for (const edu of education) {
      checkPageBreak(18);
      doc.font('Helvetica-Bold')
         .fontSize(9)
         .fillColor(darkColor)
         .text(edu.degree || 'Degree', { continued: true })
         .font('Helvetica')
         .fillColor(grayColor)
         .text(` — ${edu.institution || ''} (${edu.dates || ''})`);
    }

    const certs = Array.isArray(profile.certifications) ? profile.certifications : [];
    if (certs.length > 0) {
      checkPageBreak(18);
      doc.moveDown(0.15);
      doc.font('Helvetica-Bold')
         .fontSize(8.5)
         .fillColor(darkColor)
         .text('Certifications: ', { continued: true })
         .font('Helvetica')
         .fillColor(grayColor)
         .text(certs.join('   •   '));
    }

    // Add clean page numbers to all pages (set margins.bottom = 0 and lineBreak: false to prevent trailing empty pages)
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const oldBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica')
         .fontSize(7.5)
         .fillColor('#94a3b8')
         .text(
           `${candidateName}  —  Tailored Resume (${candidateProfession})  |  Page ${i + 1} of ${range.count}`,
           doc.page.margins.left,
           doc.page.height - 20,
           { align: 'center', width: doc.page.width - (doc.page.margins.left * 2), lineBreak: false }
         );
      doc.page.margins.bottom = oldBottom;
    }

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { buildFullDepthResumePdf };
