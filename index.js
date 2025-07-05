const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright-chromium'); // let op: playwright-chromium!
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Helper om screenshots te maken
async function takeScreenshot(page, name) {
  const dir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const filePath = path.join(dir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`📸 Screenshot opgeslagen als: ${filePath}`);
}

app.post('/run', (req, res) => {
  console.log('🚀 Ontvangen POST-verzoek bij /run');

  const { entry_id, webhook_url, username, password, game_id} = req.body;
  const apiKey = req.headers['x-api-key'];

  // 🔐 Beveiliging via API-key
  if (apiKey !== process.env.API_KEY) {
    console.warn('⛔ Ongeldige API key');
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }

  // ✅ Validatie van vereiste velden
  if (!entry_id || !webhook_url || !username || !password || !game_id) {
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
      await page.goto('https://creator.loquiz.com/login', { waitUntil: 'networkidle' });
      await takeScreenshot(page, '01_login_page_loaded');

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
      await takeScreenshot(page, '02_after_login');
      
      // 📄 Open bestaande game-taak voor bewerking
      const editUrl = `https://creator.loquiz.com/games/edit/${game_id}/questions?task=g9Okd0C1p`;
      console.log('📄 Ga naar:', editUrl);
      await page.goto(editUrl, { waitUntil: 'networkidle' });
      await takeScreenshot(page, '03_task_page_loaded');

      // 📝 Vul dummyvraag in
      console.log('📝 Vul dummytekst in...');
      const editor = page.locator('.ql-editor[contenteditable="true"]');
      await editor.waitFor({ state: 'visible', timeout: 10000 });
      await editor.fill('Dit is een dummyvraag via Playwright v4');
      await takeScreenshot(page, '04_editor_filled');
      
      // 💾 Klik op 'Create task'
      console.log('💾 Klik op Save as copy...');
      const createButton = page.locator('button:has-text("Save as copy")');
      await createButton.waitFor({ state: 'visible', timeout: 10000 });
      await createButton.click();

      // 🥳 Klaar
      console.log('🥳 Taak succesvol aangepast');
      await takeScreenshot(page, '05_save_as_copy_clicked');

      // 📸 Screenshot na dialoog
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'screenshot.png' });
      console.log('📸 Screenshot gemaakt na Save as copy');

      let clicked = false;
      for (let i = 0; i < 30; i++) {
        const buttons = await page.$$('a.btn'); // Haal ALLE knoppen op
        console.log(`🔍 Poging ${i}: aantal knoppen gevonden: ${buttons.length}`);

        for (const btn of buttons) {
            const text = (await btn.textContent())?.trim();
            const className = await btn.getAttribute('class');
            console.log(`🔘 Gevonden knop: class="${className}", tekst="${text}"`);
        
            if (className.includes('btn-success') && text === '4. Save') {
              await btn.click();
              console.log('💾 Eindsave uitgevoerd');
              clicked = true;
              await takeScreenshot(page, '07_final_save_clicked');
              break;
            }
            if (clicked) {
              break; // breek buitenste loop direct zodra geklikt is
            }
          }
        await page.waitForTimeout(1000); // 1 seconde pauze
      }
      
      if (!clicked) {
        console.warn('⚠️ Kon eind-saveknop niet vinden');
        await takeScreenshot(page, '06_after_lightbox_closed');
        throw new Error('❌ Eind-saveknop "4. Save" niet gevonden binnen tijdslimiet');
      }

      // ✅ Koppel terug naar WordPress
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
      
      } catch (err) {
        console.error('❌ Fout tijdens uitvoeren:', err);
      } finally {
      if (browser) {
        await browser.close();
        console.warn('⚠️ Browser gesloten');
      }
    }
  })();
});

app.get('/screenshot/:name', (req, res) => {
  const file = path.join(__dirname, 'screenshots', `${req.params.name}.png`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).send('Screenshot niet gevonden');
  }
});

app.get('/', (req, res) => {
  res.send('👋 Hello!');
});

app.listen(port, () => {
  console.log(`🌍 Server draait op poort ${port}`);
});
