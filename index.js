const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright-chromium'); // let op: playwright-chromium!
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

app.post('/run', (req, res) => {
  console.log('🚀 Ontvangen POST-verzoek bij /run');

  const { entry_id, webhook_url } = req.body;

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
      await page.goto('https://www.loquiz.com');

      console.log('✅ Pagina geladen');

      // Hier eventueel login/actie toevoegen
      // await page.fill('input[name="email"]', '...');
      // await page.fill('input[name="password"]', '...');
      // await page.click('button[type="submit"]');

      await browser.close();
      console.log('🧹 Browser gesloten');

      // ✅ Koppel terug naar WordPress
      console.log('➡️ Callback wordt verstuurd naar:', webhook_url);
      console.log('➡️ Payload:', JSON.stringify({ entry_id }));

      try {
        const response = await fetch(webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entry_id })
        });
      
        const text = await response.text();
        console.log(`✅ WordPress response (${response.status}):`, text);
      } catch (err) {
        console.error('❌ Fout bij fetch naar WordPress:', err);
      }


      console.log(`📬 Callback naar WordPress verstuurd voor entry ${entry_id}`);

    } catch (error) {
      console.error('❌ Fout tijdens browseractie:', error);
      if (browser) {
        await browser.close();
        console.warn('⚠️ Browser gesloten na fout');
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
