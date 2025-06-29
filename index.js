const express = require('express');
const { chromium } = require('playwright');

console.log('🟢 Server initialiseren...');

const app = express();
app.use(express.json());

// ✅ API-key beveiliging
const API_KEY = 'Bandits2022!';
app.use('/run', (req, res, next) => {
  console.log('🔐 API-key check wordt uitgevoerd');
  const incomingKey = req.headers['x-api-key'];
  if (incomingKey !== API_KEY) {
    console.warn('🚫 Ongeldige API-key');
    return res.status(403).json({ success: false, message: 'Forbidden: Invalid API key' });
  }
  console.log('✅ API-key geldig');
  next();
});

app.post('/run', async (req, res) => {
  console.log('🚀 /run endpoint aangeroepen');

  const data = req.body;
  console.log('📦 Ontvangen body:', data);

  const formData = {
    username: data.username || 'support@breakoutbandits.com',
    password: data.password || 'Bandits2022!',
  };

  console.log('🧠 Inloggegevens voorbereid. Browser wordt gestart...');

  let browser;
  try {
      browser = await chromium.launch({
    headless: true,
    executablePath: '/opt/render/.cache/ms-playwright/chromium-1179/chrome-linux/chrome',
    args: ['--no-sandbox']
  });
    console.log('🌐 Chromium succesvol gestart');

    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('🌍 Navigeren naar inlogpagina...');
    await page.goto('https://creator.loquiz.com/login', { waitUntil: 'networkidle' });

    console.log('✍️ Inloggegevens invullen...');
    await page.fill('input[placeholder*="email" i]', formData.username);
    await page.fill('input[placeholder*="password" i]', formData.password);

    console.log('🔓 Inloggen...');
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle' }),
    ]);

    const pageUrl = page.url();
    console.log('🌐 Huidige URL na login:', pageUrl);

    if (pageUrl.includes('/dashboard') || !pageUrl.includes('/login')) {
      console.log('✅ Inloggen gelukt');
      res.json({ success: true, message: '✅ Succesvol ingelogd op Loquiz' });
    } else {
      console.warn('❌ Login mislukt');
      res.status(401).json({ success: false, message: '❌ Login mislukt' });
    }

  } catch (err) {
    console.error('❌ Fout tijdens loginproces:', err);
    res.status(500).json({ success: false, error: err.toString() });

  } finally {
    if (browser) {
      await browser.close();
      console.log('🧹 Browser gesloten');
    } else {
      console.warn('⚠️ Browser was niet opgestart, dus niet gesloten');
    }
  }
});

app.get('/', (req, res) => {
  console.log('📥 GET / aangeroepen');
  res.send('✅ Playwright-service draait');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌐 Server draait op poort ${PORT}`);
});
