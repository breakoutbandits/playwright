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

// Antwoorden invullen / vervangen o.b.v. placeholders in Loquiz
async function vulAntwoorden(page, { option1, option2, option3, option4 }) {
  // Wacht tot het answers-component zichtbaar is (maakt de functie robuuster)
  try {
    await page.locator('app-answers-input, [formcontrolname="answers"]').first()
      .waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    console.warn('⚠️ Geen answers-component gevonden — sla vullen van antwoorden over.');
    return { found: 0, replaced: 0 };
  }

  // Map placeholders -> opgegeven opties
  const mapping = {
    '%an1': option1,
    '%an2': option2,
    '%an3': option3,
    '%an4': option4,
  };

  // Pak alle tekst-inputs binnen de antwoordgroepen
  const inputs = page.locator('.answers__group input[type="text"]');
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
      
      // 📂 Verwerk alle tasks
      for (const [i, task] of tasks.entries()) {
        console.log(`🔁 Taak ${i + 1}/${tasks.length}: ${task.task_id}`);
        const url = `https://creator.loquiz.com/games/edit/${game_id}/questions?task=${task.task_id}`;
        console.log('📄 Open URL:', url);
        await page.goto(url, { waitUntil: 'networkidle' });
        await takeScreenshot(page, `task_${i + 1}_loaded`);

        // 📝 Vul vraagtekst in (Loquiz label en antwoord)
        if (task.content) {
          const editor = page.locator('.ql-editor[contenteditable="true"]');
          await editor.waitFor({ state: 'visible', timeout: 10000 });
          const newText = `${task.content}`;
          await editor.fill(newText);
          console.log('📝 Editor gevuld:', newText);
        }

        // Vul antwoorden
        if (task.answer_good_name){
          await vulAntwoorden(page, {
            option1: task.answer_good_name,
            option2: task.answer_wrong1_name,
            option3: task.answer_wrong2_name,
            option4: task.answer_wrong3_name
          });
          console.log('✅ Antwoorden ingevuld');
          await takeScreenshot(page, `task_${i + 1}_editor_filled`);
        }

        // 💬 Voeg commentaar toe als aanwezig
        if (task.comment && task.comment.trim() !== '') {
          console.log('💬 Commentaar toevoegen');
          const commentsButton = page.locator('button:has-text("Comments")');
          await commentsButton.click();
          await takeScreenshot(page, `task_${i + 1}_comments_tab`);

          const commentEditor = page.locator('app-html-editor[formcontrolname="correctComment"] .ql-editor[contenteditable="true"]');
          await commentEditor.waitFor({ state: 'visible', timeout: 10000 });
          await commentEditor.fill(task.comment);
          console.log('💬 Comment ingevuld:', task.comment);
          await takeScreenshot(page, `task_${i + 1}_comment_filled`);
        }

        // 💾 Klik op "Save as copy"
        const saveCopyButton = page.locator('button:has-text("Save as copy")');
        await saveCopyButton.waitFor({ state: 'visible', timeout: 10000 });
        await saveCopyButton.click();
        console.log('💾 Save as copy geklikt');
        await takeScreenshot(page, `task_${i + 1}_save_copy`);

        // ✅ Wacht op dialoogafsluiting
        await page.waitForTimeout(1000);

        // 🔍 Zoek de juiste "4. Save"-knop
        let clicked = false;
        for (let j = 0; j < 30; j++) {
          const buttons = await page.$$('a.btn');
          console.log(`🔍 Poging ${j}: ${buttons.length} knoppen gevonden`);
          for (const btn of buttons) {
            const text = (await btn.textContent())?.trim();
            const className = await btn.getAttribute('class');
            console.log(`🔘 class="${className}", tekst="${text}"`);

            if (className.includes('btn-success') && text === '4. Save') {
              await btn.click();
              console.log('✅ Eind-save uitgevoerd');
              await takeScreenshot(page, `task_${i + 1}_final_save`);
              clicked = true;
              break;
            }
          }
          if (clicked) break;
          await page.waitForTimeout(1000);
        }

        if (!clicked) {
          await takeScreenshot(page, `task_${i + 1}_save_not_found`);
          throw new Error(`❌ Eind-saveknop niet gevonden voor taak ${task.task_id}`);
        }
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
