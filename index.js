const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright-chromium'); // let op: playwright-chromium!
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

app.post('/run', (req, res) => {
  console.log('🚀 Ontvangen POST-verzoek bij /run');

  const { entry_id, webhook_url, username, password } = req.body;

  if (!entry_id || !webhook_url) {
    console.error('❌ Vereiste velden ontbreken in de request');
    return res.status(400).json({ success: false, error: 'entry_id of webhook_url ontbreekt' });
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
      
      await emailField.waitFor(); // expliciet wachten op stabiliteit
      await emailField.fill(username);
      await passwordField.fill(password);
      
      await page.click('button[type="submit"]');

      // ✅ Wacht op navigatie naar dashboard
      await page.waitForNavigation({ waitUntil: 'networkidle' });
      console.log('✅ Ingelogd');
      
      // 📄 Ga naar de task-creator pagina
      console.log('📄 Open task-pagina...');
      await page.goto('https://creator.loquiz.com/questions?task=new', { waitUntil: 'networkidle' });
      
      // 📝 Vul dummyvraag in
      console.log('📝 Vul dummytekst in...');
      const editor = page.locator('.ql-editor[contenteditable="true"]');
      await editor.waitFor({ state: 'visible', timeout: 10000 });
      await editor.fill('Dit is een dummyvraag via Playwright');
      
      // ⚙️ Selecteer antwoordtype
      console.log('⚙️ Selecteer antwoordtype...');
      const answerSelect = page.locator('select[formcontrolname="answerType"]');
      await answerSelect.waitFor({ state: 'visible', timeout: 10000 });
      await answerSelect.selectOption('none');
      
      // 💾 Klik op 'Create task'
      console.log('💾 Klik op Create task...');
      const createButton = page.locator('button:has-text("Create task")');
      await createButton.waitFor({ state: 'visible', timeout: 10000 });
      await createButton.click();
      
      // 🥳 Klaar
      console.log('🥳 Taak succesvol aangemaakt');

      
      // ✅ Koppel terug naar WordPress
      console.log('➡️ Callback wordt verstuurd naar:', webhook_url);
      console.log('➡️ Payload:', JSON.stringify({ entry_id }));

      
        const response = await fetch(webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entry_id })
        });
      
        const text = await response.text();
        console.log(`✅ WordPress response (${response.status}):`, text);
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
