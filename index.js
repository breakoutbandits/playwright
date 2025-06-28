const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();
app.use(express.json());

// ✅ API-key beveiliging
const API_KEY = 'Bandits2022!';
app.use('/run', (req, res, next) => {
  console.log('🔐 API-key check wordt uitgevoerd');
  const incomingKey = req.headers['x-api-key'];
  if (incomingKey !== API_KEY) {
    console.warn('⛔ Ongeldige API-key ontvangen:', incomingKey);
    return res.status(403).json({ success: false, message: 'Forbidden: Invalid API key' });
  }
  console.log('✅ API-key geldig');
  next();
});

app.post('/run', async (req, res) => {
  console.log('🚀 /run endpoint aangeroepen');
  console.log('📦 Ontvangen body:', req.body);

  const formData = {
    username: req.body.username || 'support@breakoutbandits.com',
    password: req.body.password || 'Bandits2022!',
  };

  const browserPath = '/opt/render/.cache/ms-playwright/chromium-1179/chrome-linux/chrome';
  const browserExists = fs.existsSync(browserPath);

  if (!browserExists) {
    console.error('❌ Chromium niet gevonden op pad:', browserPath);
    return res.status(500).json({ success: false, message: 'Chromium executable ontbreekt' });
  } else {
    console.log('✅ Chromium gevonden op pad:', browserPath);
  }

  let browser;
  try {
    console.log('🧪 Chromium wordt gestart...');
    browser = await chromium.launch({
      headless: true,
      executablePath: browserPath,
      args: ['--no-sandbox']
    });
    console.log('🟢 Chromium succesvol gestart');
  } catch (launchErr) {
    console.error('🔥 Fout bij starten van Chromium:', launchErr);
    return res.status(500).json({ success: false, error: launchErr.toString() });
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('🌍 Navigeren naar inlogpagina...');
    await page.goto('https://creator.loquiz.com/login', { waitUntil: 'networkidle' });

    // Vul email en wachtwoord in
    await page.fill('input[placeholder*="email" i]', formData.username);
    await page.fill('input[placeholder*="password" i]', formData.password);

    console.log('🔑 Loginformulier ingevuld. Proberen in te loggen...');

    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle' })
    ]);

    const pageUrl = page.url();
    console.log('🌐 Huidige URL na login:', pageUrl);

    if (pageUrl.includes('/dashboard') || !pageUrl.includes('/login')) {
      console.log('✅ Login succesvol');
      res.json({ success: true, message: '✅ Succesvol ingelogd op Loquiz' });
    } else {
      console.warn('⚠️ Login lijkt mislukt');
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
  console.log('📡 GET / aangeroepen');
  res.send('✅ Playwright-service draait');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 Server draait op poort ${PORT}`));
