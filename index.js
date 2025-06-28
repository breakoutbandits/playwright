const express = require('express');
const { chromium } = require('playwright'); // Gebruik Playwright

const app = express();
app.use(express.json());

// ✅ API-key beveiliging
const API_KEY = 'Bandits2022!';
app.use('/run', (req, res, next) => {
  const incomingKey = req.headers['x-api-key'];
  if (incomingKey !== API_KEY) {
    return res.status(403).json({ success: false, message: 'Forbidden: Invalid API key' });
  }
  next();
});

app.post('/run', async (req, res) => {
  console.log('🚀 /run endpoint aangeroepen');
  const data = req.body;

  const formData = {
    username: data.username || 'support@breakoutbandits.com',
    password: data.password || 'Bandits2022!',
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('🌍 Navigeren naar inlogpagina...');
    await page.goto('https://creator.loquiz.com/login', { waitUntil: 'networkidle' });

    // Vul email en wachtwoord in
    await page.fill('input[placeholder*="email" i]', formData.username);
    await page.fill('input[placeholder*="password" i]', formData.password);

    // Klik op inloggen
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle' })
    ]);

    const pageUrl = page.url();
    console.log('🌐 Huidige URL na login:', pageUrl);

    if (pageUrl.includes('/dashboard') || !pageUrl.includes('/login')) {
      res.json({ success: true, message: '✅ Succesvol ingelogd op Loquiz' });
    } else {
      res.status(401).json({ success: false, message: '❌ Login mislukt' });
    }

  } catch (err) {
    console.error('❌ Fout tijdens loginproces:', err);
    res.status(500).json({ success: false, error: err.toString() });
  } finally {
    await browser.close();
    console.log('🧹 Browser gesloten');
  }
});

app.get('/', (req, res) => {
  res.send('✅ Playwright-service draait');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 Server draait op poort ${PORT}`));
