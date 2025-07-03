const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright-chromium'); // let op: playwright-chromium!
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

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
      
      // 📄 Ga naar de task-editor pagina
      //console.log('📄 Open task-pagina...');
      //await page.goto('https://creator.loquiz.com/games/edit/F3YSSVDWCJ/questions?task=GHyDl2RAY', { waitUntil: 'networkidle' });

      // 📄 Open bestaande game-taak voor bewerking
      const editUrl = `https://creator.loquiz.com/games/edit/${game_id}/questions?task=GHyDl2RAY`;
      console.log('📄 Ga naar:', editUrl);
      await page.goto(editUrl, { waitUntil: 'networkidle' });

      
      // 📝 Vul dummyvraag in
      console.log('📝 Vul dummytekst in...');
      const editor = page.locator('.ql-editor[contenteditable="true"]');
      await editor.waitFor({ state: 'visible', timeout: 10000 });
      await editor.fill('Dit is een dummyvraag via Playwright');
      
      // ⚙️ Selecteer antwoordtype
      //console.log('⚙️ Selecteer antwoordtype...');
      //const answerSelect = page.locator('select[formcontrolname="answerType"]');
      //await answerSelect.waitFor({ state: 'visible', timeout: 10000 });
      //await answerSelect.selectOption('none');
      
      // 💾 Klik op 'Create task'
      console.log('💾 Klik op Save as copy...');
      const createButton = page.locator('button:has-text("Save as copy")');
      await createButton.waitFor({ state: 'visible', timeout: 10000 });
      await createButton.click();

      // 🥳 Klaar
      console.log('🥳 Taak succesvol aangepast');

      // ❎ Wacht tot dialoog sluit (Angular component)
      await page.waitForSelector('app-dialog-box', { state: 'detached', timeout: 10000 });
      console.log('📦 Dialoog gesloten');
      
      // ✅ Wacht op "4. Save" knop na dialog actie
      console.log('🕵️ Wachten op knop "4. Save"...');
      
      await page.waitForFunction(() => {
        const buttons = [...document.querySelectorAll('a.btn.btn-success')];
        return buttons.some(el => el.textContent.trim() === '4. Save');
      }, { timeout: 15000 });
      
      console.log('✅ Knop "4. Save" gevonden, nu klikken...');
      await page.click('a.btn.btn-success:has-text("4. Save")');
      console.log('📥 Game opgeslagen');

      
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

app.get('/', (req, res) => {
  res.send('👋 Hello!');
});

app.listen(port, () => {
  console.log(`🌍 Server draait op poort ${port}`);
});
