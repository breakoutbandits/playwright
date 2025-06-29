const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright-chromium'); // let op: playwright-chromium!

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

app.post('/run', async (req, res) => {
  console.log('🚀 Ontvangen POST-verzoek bij /run');

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      chromiumSandbox: false // belangrijk voor Heroku!
    });

    console.log('🌐 Chromium succesvol gestart');

    const page = await browser.newPage();
    await page.goto('https://www.loquiz.com');

    // Eventueel: login met username/password
    // await page.fill('input[name="email"]', req.body.username);
    // await page.fill('input[name="password"]', req.body.password);
    // await page.click('button[type="submit"]');

    console.log('✅ Pagina geladen');

    await browser.close();
    res.json({ success: true, message: 'Browserrun voltooid.' });

  } catch (error) {
    console.error('❌ Fout tijdens browseractie:', error);
    if (browser) {
      await browser.close();
      console.warn('⚠️ Browser werd gesloten na fout');
    }
    res.json({ success: false, error: error.toString() });
  }
});

app.listen(port, () => {
  console.log(`🌍 Server draait op poort ${port}`);
});
