const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright-chromium'); // let op: playwright-chromium!
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Oude code - app.use(bodyParser.json());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// ---- Brevo API mailer (geen Nodemailer nodig)
async function sendWarningViaBrevoAPI({ subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('❌ BREVO_API_KEY ontbreekt');
    throw new Error('BREVO_API_KEY ontbreekt');
  }

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: { email: process.env.ALERT_FROM || 'info@breakoutbandits.com', name: 'Breakout Bandits' },
      to: [{ email: process.env.ALERT_TO || 'info@breakoutbandits.com', name: 'Ops' }],
      subject,
      htmlContent: html,
    }),
  });

  const body = await resp.text();
  if (!resp.ok) {
    console.error('❌ Brevo API send failed:', resp.status, body);
    throw new Error(`Brevo API error ${resp.status}`);
  }
  console.log('📧 Brevo API send ok:', body);
}

// ========= Placeholder-check op /results =========
async function checkResultsPlaceholders(page, gameId) {
  const url = `https://results.loquiz.com/${gameId}/answers`;
  console.log('🔎 Placeholder-check op:', url);

  page.setDefaultNavigationTimeout(60000);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Wacht expliciet tot de UI gerenderd is: <div class="container container--fluid">
  await page.waitForSelector('.container.container--fluid', { state: 'visible', timeout: 45000 });

  // Korte ademruimte voor eventueel laatste client-side render
  await page.waitForTimeout(500);

  // haal de GERENDERDE DOM op
  const html = await page.content();

  // lijst met te controleren placeholders
  const keys = ['%q','%a1','%an1','%a2','%an2','%a3','%an3','%a4','%an4','%g','%check'];

  const found = [];
  for (const k of keys) {
    let idx = html.indexOf(k);
    if (idx !== -1) {
      // context rondom de placeholder pakken
      const start = Math.max(0, idx - 80);
      const end   = Math.min(html.length, idx + k.length + 80);
      const context = html.slice(start, end).replace(/\s+/g, ' ');
      found.push({ placeholder: k, context });
    }
  }

  const ok = found.length === 0;
  if (ok) {
    console.log('✅ Geen placeholders meer gevonden');
  } else {
    console.warn('⚠️ Nog gevonden placeholders:');
    for (const f of found) {
      console.warn(`- ${f.placeholder} ...context: "${f.context}"`);
    }
  }

  return { ok, found };
}


// Helper om screenshots te maken
//async function takeScreenshot(page, name) {
//  const dir = path.join(__dirname, 'screenshots');
//  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
//  const filePath = path.join(dir, `${name}.png`);
//  await page.screenshot({ path: filePath, fullPage: true });
//  console.log(`📸 Screenshot opgeslagen als: ${filePath}`);
//}

// Antwoorden invullen / vervangen o.b.v. placeholders in Loquiz
async function vulAntwoorden(page, { option1, option2, option3, option4 }) {
  // Wacht tot het answers-component zichtbaar is (maakt de functie robuuster)
  const answersComponent = page.locator(
    'app-dialog-box app-answers-input[formcontrolname="answers"]'
  ).last();

  try {
    await answersComponent
      .waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    console.warn('⚠️ Geen answers-component gevonden — sla vullen van antwoorden over.');
    return { found: 0, replaced: 0 };
  }

  // Map placeholders -> opgegeven opties
  const mapping = {
    '%an1': decodeHtmlEntities(option1),
    '%an2': decodeHtmlEntities(option2),
    '%an3': decodeHtmlEntities(option3),
    '%an4': decodeHtmlEntities(option4),
  };

  // Pak alle tekst-inputs binnen de antwoordgroepen
  const inputs = answersComponent.locator(
    'input.input:not([placeholder="Add an answer..."]):not([disabled])'
  );

  const count = await inputs.count();
  console.log(`🧩 Antwoorden gevonden: ${count}`);

  let replaced = 0;

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    try {
      // huidige value lezen (géén placeholder attribute)
      const current = (await input.inputValue()).trim();

      // Alleen vervangen als de value exact een bekende placeholder is
      if (Object.prototype.hasOwnProperty.call(mapping, current)) {
        const newValue = mapping[current];

        if (newValue && `${newValue}`.trim().length > 0) {
          await input.fill(newValue);
          console.log(`✅ Veld ${i + 1}: "${current}" → "${newValue}"`);
          replaced++;
        } else {
          console.log(`⏭️  Veld ${i + 1}: "${current}" niet vervangen (ontbrekende/lege optie).`);
        }
      } else {
        console.log(`🔎 Veld ${i + 1}: geen placeholder gevonden (waarde="${current}") — laten staan.`);
      }
    } catch (err) {
      console.warn(`⚠️ Kon veld ${i + 1} niet verwerken:`, err);
      // ga door met de rest
    }
  }

  console.log(`📊 Samenvatting: ${replaced}/${count} velden vervangen op basis van placeholders.`);
  return { found: count, replaced };
}

function decodeHtmlEntities(str) {
  if (typeof str !== 'string' || !str) return str;

  // Decode numeric hex: &#x2764;
  str = str.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
  });

  // Decode numeric dec: &#10084;
  str = str.replace(/&#([0-9]+);/g, (_, dec) => {
    try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _; }
  });

  return str;
}

// Main route
app.post('/run', (req, res) => {
  console.log('🚀 Ontvangen POST-verzoek bij /run');

  const { entry_id, webhook_url, username, password, game_id, tasks} = req.body;
  const apiKey = req.headers['x-api-key'];

  // 🔐 Beveiliging via API-key
  if (apiKey !== process.env.API_KEY) {
    console.warn('⛔ Ongeldige API key');
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }

  // ✅ Validatie van vereiste velden
  if (!entry_id || !webhook_url || !username || !password || !game_id || !tasks || !tasks.length) {
    console.error('❌ Ontbrekende velden in request');
    return res.status(400).json({ success: false, error: 'Verplichte velden ontbreken' });
  }

  // Geef direct een response terug aan WordPress (max 5 sec wachten daar)
  res.json({ success: true, message: 'Script gestart op achtergrond' });

  // Start de browseractie op de achtergrond
  (async () => {
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        chromiumSandbox: false
      });

      console.log('🌐 Chromium succesvol gestart');

      const page = await browser.newPage();
      console.log('🌐 Ga naar inlogpagina...');
      // DEPRICATED initial code --> await page.goto('https://creator.loquiz.com/login', { waitUntil: 'networkidle' });
      // DEPRICATED legacy creator --> await page.goto('https://legacy.loquiz.com/login', { waitUntil: 'networkidle' });
      await page.goto('https://creator.loquiz.com/login', { waitUntil: 'networkidle' });
      //await takeScreenshot(page, '01_login_page_loaded');

      console.log('🔐 Inloggen...');
      const emailField = page.locator('app-input[formcontrolname="email"] input');
      const passwordField = page.locator('app-input[formcontrolname="password"] input');
      
      await emailField.waitFor({ state: 'visible', timeout: 10000 });
      await passwordField.waitFor({ state: 'visible', timeout: 10000 });
      
      await emailField.fill(username);
      await passwordField.fill(password);
      await page.click('button[type="submit"]');

      // ✅ Wacht op navigatie naar dashboard
      await page.waitForNavigation({ waitUntil: 'networkidle' });
      console.log('✅ Ingelogd');
      //await takeScreenshot(page, '02_after_login');
      
      // 📂 Verwerk alle tasks
      for (const [i, task] of tasks.entries()) {
        console.log(`🔁 Taak ${i + 1}/${tasks.length}: ${task.task_id}`);
        // DEPRICATED initial code --> const url = `https://creator.loquiz.com/games/edit/${game_id}/questions?task=${task.task_id}`;
        // DEPRICATED legacy creator --> const url = `https://legacy.loquiz.com/games/edit/${game_id}/questions?task=${task.task_id}`;
        const url = `https://creator.loquiz.com/games/edit/${game_id}/creator?task=${task.task_id}`;
        console.log('📄 Open URL:', url);
        await page.goto(url, { waitUntil: 'networkidle' });
        //await takeScreenshot(page, `task_${i + 1}_loaded`);

        // ✅ Wacht tot de nieuwe taakdialoog zichtbaar is
        const taskDialog = page.locator('app-dialog-box').last();
        await taskDialog.waitFor({ state: 'visible', timeout: 30000 });
        console.log('✅ Taakdialoog geopend');

        // 📝 Vul vraagtekst in (Loquiz label en antwoord)
        if (task.content) {
          const editor = taskDialog.locator(
            'app-html-editor[formcontrolname="text"] .ql-editor[contenteditable="true"]'
          );
          await editor.waitFor({ state: 'visible', timeout: 30000 });
          const newText = decodeHtmlEntities(String(task.content));
          await editor.fill(newText);
          console.log('📝 Editor gevuld:', newText);
        }

        // Vul antwoorden
        if (task.answers_same == 'Yes'){
          await vulAntwoorden(page, {
            option1: task.static_multiple_choice_answer_good,
            option2: task.static_multiple_choice_answer_wrong1,
            option3: task.static_multiple_choice_answer_wrong2,
            option4: task.static_multiple_choice_answer_wrong3
          });
          console.log('✅ Statische antwoorden ingevuld voor allemaal zelfde antwoorden ');
          //await takeScreenshot(page, `task_${i + 1}_editor_filled`);
        } else {
          await vulAntwoorden(page, {
            option1: task.answer_good_name,
            option2: task.answer_wrong1_name,
            option3: task.answer_wrong2_name,
            option4: task.answer_wrong3_name
          });
          console.log('✅ Antwoorden ingevuld');
          //await takeScreenshot(page, `task_${i + 1}_editor_filled`);
        }

        // 💬 Voeg commentaar toe als aanwezig
        if (task.comment && task.comment.trim() !== '') {
          console.log('💬 Commentaar toevoegen');
          const commentsButton = taskDialog.getByRole('tab', {
            name: 'Comments',
            exact: true
          });
          await commentsButton.click();
          //await takeScreenshot(page, `task_${i + 1}_comments_tab`);

          const commentEditor = taskDialog.locator(
            'app-html-editor[formcontrolname="correctComment"] .ql-editor[contenteditable="true"]'
          );
          await commentEditor.waitFor({ state: 'visible', timeout: 10000 });
          await commentEditor.fill(task.comment);
          console.log('💬 Comment ingevuld:', task.comment);
          //await takeScreenshot(page, `task_${i + 1}_comment_filled`);
        }

        // 💾 Klik op "Save as copy"
        const saveCopyButton = taskDialog
          .locator('app-dialog-box-footer')
          .getByRole('button', {
            name: 'Save as copy',
            exact: true
          });

        await saveCopyButton.waitFor({ state: 'visible', timeout: 10000 });
        await saveCopyButton.click();
        console.log('💾 Save as copy geklikt');
        //await takeScreenshot(page, `task_${i + 1}_save_copy`);

        // ✅ Wacht op dialoogafsluiting
        await taskDialog.waitFor({
          state: 'hidden',
          timeout: 30000
        });

        console.log('✅ Dialoog gesloten na Save as copy');

        // ✅ Wacht tot de Creator na "Save as copy" weer volledig zichtbaar is
        await page.locator('.navbar-end').waitFor({
          state: 'visible',
          timeout: 30000
        });

        // 🔍 Zoek de nieuwe "Save"-knop
        const finalSaveButton = page.locator(
          '.navbar-end button.btn-primary:has-text("Save")'
        );

        await finalSaveButton.waitFor({
          state: 'visible',
          timeout: 30000
        });

        // ✅ Wacht totdat de Save-knop daadwerkelijk klikbaar is
        await page.waitForFunction(() => {
          const button = [...document.querySelectorAll('.navbar-end button.btn-primary')]
            .find(btn => btn.textContent.trim() === 'Save');

          return button && !button.disabled;
        }, null, { timeout: 30000 });

        console.log('💾 Eind-saveknop is beschikbaar');

        await finalSaveButton.click();

        console.log('✅ Eind-save uitgevoerd');
        //await takeScreenshot(page, `task_${i + 1}_final_save`);

        // ✅ Wacht op bevestiging dat Loquiz klaar is met opslaan.
        // Na succesvolle save wordt de knop disabled.
        await page.waitForFunction(() => {
          const button = [...document.querySelectorAll('.navbar-end button.btn-primary')]
            .find(btn => btn.textContent.trim() === 'Save');

          return button && button.disabled;
        }, null, { timeout: 30000 });

        console.log('✅ Save bevestigd door Loquiz');
      }

      // ✅ Alle tasks verwerkt — nu placeholder-check doen vóór WP-callback
      try {
        const { ok, found } = await checkResultsPlaceholders(page, game_id);
      
        if (!ok) {
          console.warn('⚠️ Placeholder-check FAALT. Niet-vervangen placeholders gevonden.');
      
          // simpele HTML-escape voor de mail
          const esc = (s) => String(s).replace(/[&<>]/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]
          ));
      
          const subject = `⚠️ Warning: Loquiz game ${game_id} niet goed geconfigureerd!`;
          const itemsHtml = found.map(f => (
            `<li style="margin-bottom:10px">
               <code>${esc(f.placeholder)}</code>
               <div style="font-family:monospace;background:#f6f8fa;padding:10px;border-radius:6px;white-space:nowrap;overflow:auto">
                 ${esc(f.context)}
               </div>
             </li>`
          )).join('');
      
          const html = `
            <p>Na het verwerken van de taken zijn er nog placeholders aangetroffen op
            <a href="https://results.loquiz.com/${game_id}/answers" target="_blank" rel="noreferrer">results.loquiz.com/${game_id}/answers</a>:</p>
            <ul>${itemsHtml}</ul>
            <p>Graag controleren en opnieuw draaien.</p>
          `;
      
          await sendWarningViaBrevoAPI({ subject, html });
      
          // ❌ Bij failure géén WP-callback sturen
          console.warn('⏹ WP-callback overgeslagen vanwege placeholder-fouten.');
        } else {
          console.log('✅ Placeholder-check OK — alle placeholders zijn vervangen.');
      
          // 🔁 Terugkoppeling naar WordPress
          console.log('➡️ Callback wordt verstuurd naar:', webhook_url);
          console.log('➡️ Payload:', JSON.stringify({ entry_id }));
      
          const callbackResponse = await fetch(webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entry_id })
          });
      
          const text = await callbackResponse.text();
          console.log(`✅ WordPress response (${callbackResponse.status}):`, text);
      
          if (!callbackResponse.ok) {
            throw new Error(`❌ WP callback mislukt met status ${callbackResponse.status}`);
          }
        }
      } catch (e) {
        console.error('❌ Fout tijdens placeholder-check / e-mail:', e);
        // Optioneel: hier kun je alsnog een WP-callback proberen of extra logging doen.
      }

      } catch (err) {
        console.error('❌ Fout tijdens uitvoeren:', err);        

        // === Mail via Brevo bij runtime error ===
        try {
          const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]
          ));
  
          const subject = `❌ Error in Loquiz Playwright script (game ${game_id}, entry ${entry_id})`;
  
          const stack = err?.stack ? String(err.stack) : String(err);
          const html = `
            <p><strong>Er is een fout opgetreden tijdens het uitvoeren van het Playwright-script.</strong></p>
  
            <p><strong>Entry ID:</strong> ${esc(entry_id)}<br/>
               <strong>Game ID:</strong> ${esc(game_id)}<br/>
               <strong>Tasks:</strong> ${Array.isArray(tasks) ? tasks.length : 0}</p>
  
            <p><strong>Error message:</strong></p>
            <pre style="font-family:monospace;background:#f6f8fa;padding:12px;border-radius:8px;white-space:pre-wrap;overflow:auto">${esc(stack)}</pre>
  
            <p><strong>Webhook URL:</strong> ${esc(webhook_url || '')}</p>
          `;
  
          await sendWarningViaBrevoAPI({ subject, html });
        } catch (mailErr) {
          console.error('❌ Kon error-mail via Brevo niet versturen:', mailErr);
        }
      
      } finally {
      if (browser) {
        await browser.close();
        console.warn('⚠️ Browser gesloten');
      }
    }
  })();
});

//app.get('/screenshot/:name', (req, res) => {
//  const file = path.join(__dirname, 'screenshots', `${req.params.name}.png`);
//  if (fs.existsSync(file)) {
//    res.sendFile(file);
//  } else {
//    res.status(404).send('Screenshot niet gevonden');
//  }
//});

app.get('/', (req, res) => {
  res.send('👋 Hello!');
});

app.listen(port, () => {
  console.log(`🌍 Server draait op poort ${port}`);
});
