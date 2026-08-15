const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright-chromium');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// =========================================================
// Brevo API mailer
// =========================================================

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
      sender: {
        email: process.env.ALERT_FROM || 'info@breakoutbandits.com',
        name: 'Breakout Bandits'
      },
      to: [{
        email: process.env.ALERT_TO || 'info@breakoutbandits.com',
        name: 'Ops'
      }],
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


// =========================================================
// Placeholder-check op /results
// =========================================================

async function checkResultsPlaceholders(page, gameId) {
  const url = `https://results.loquiz.com/${gameId}/answers`;

  console.log('🔎 Placeholder-check op:', url);

  page.setDefaultNavigationTimeout(60000);

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  await page.waitForSelector(
    '.container.container--fluid',
    {
      state: 'visible',
      timeout: 45000
    }
  );

  await page.waitForTimeout(500);

  const html = await page.content();

  const keys = [
    '%q',
    '%a1',
    '%an1',
    '%a2',
    '%an2',
    '%a3',
    '%an3',
    '%a4',
    '%an4',
    '%g',
    '%check'
  ];

  const found = [];

  for (const k of keys) {
    const idx = html.indexOf(k);

    if (idx !== -1) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(
        html.length,
        idx + k.length + 80
      );

      const context = html
        .slice(start, end)
        .replace(/\s+/g, ' ');

      found.push({
        placeholder: k,
        context
      });
    }
  }

  const ok = found.length === 0;

  if (ok) {
    console.log('✅ Geen placeholders meer gevonden');
  } else {
    console.warn('⚠️ Nog gevonden placeholders:');

    for (const f of found) {
      console.warn(
        `- ${f.placeholder} ...context: "${f.context}"`
      );
    }
  }

  return {
    ok,
    found
  };
}


// =========================================================
// HTML entities decoderen
// =========================================================

function decodeHtmlEntities(str) {
  if (typeof str !== 'string' || !str) {
    return str;
  }

  // Decode numeric hex: &#x2764;
  str = str.replace(
    /&#x([0-9a-f]+);/gi,
    (_, hex) => {
      try {
        return String.fromCodePoint(
          parseInt(hex, 16)
        );
      } catch {
        return _;
      }
    }
  );

  // Decode numeric dec: &#10084;
  str = str.replace(
    /&#([0-9]+);/g,
    (_, dec) => {
      try {
        return String.fromCodePoint(
          parseInt(dec, 10)
        );
      } catch {
        return _;
      }
    }
  );

  return str;
}


// =========================================================
// Antwoorden vervangen
//
// BELANGRIJK:
// Geen 10 seconden meer wachten als dit een informatietaak is.
// Zodra de dialog/editor geladen is, controleren we direct of
// app-answers-input aanwezig is.
// =========================================================

async function vulAntwoorden(
  taskDialog,
  {
    option1,
    option2,
    option3,
    option4
  }
) {
  const answersComponent = taskDialog.locator(
    'app-answers-input[formcontrolname="answers"]'
  );

  const componentCount = await answersComponent.count();

  // Informatietaak
  if (componentCount === 0) {
    console.log(
      'ℹ️ Geen antwoordencomponent aanwezig — informatietaak, antwoorden overgeslagen.'
    );

    return {
      found: 0,
      replaced: 0
    };
  }

  const mapping = {
    '%an1': decodeHtmlEntities(option1),
    '%an2': decodeHtmlEntities(option2),
    '%an3': decodeHtmlEntities(option3),
    '%an4': decodeHtmlEntities(option4),
  };

  const inputs = answersComponent
    .first()
    .locator(
      'input.input:not([placeholder="Add an answer..."]):not([disabled])'
    );

  const count = await inputs.count();

  console.log(
    `🧩 Antwoorden gevonden: ${count}`
  );

  let replaced = 0;

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);

    try {
      const current = (
        await input.inputValue()
      ).trim();

      if (
        Object.prototype.hasOwnProperty.call(
          mapping,
          current
        )
      ) {
        const newValue = mapping[current];

        if (
          newValue &&
          `${newValue}`.trim().length > 0
        ) {
          await input.fill(
            String(newValue)
          );

          console.log(
            `✅ Veld ${i + 1}: "${current}" → "${newValue}"`
          );

          replaced++;
        } else {
          console.log(
            `⏭️ Veld ${i + 1}: "${current}" niet vervangen (ontbrekende/lege optie).`
          );
        }
      } else {
        console.log(
          `🔎 Veld ${i + 1}: geen placeholder gevonden (waarde="${current}") — laten staan.`
        );
      }
    } catch (err) {
      console.warn(
        `⚠️ Kon veld ${i + 1} niet verwerken:`,
        err
      );
    }
  }

  console.log(
    `📊 Samenvatting: ${replaced}/${count} velden vervangen op basis van placeholders.`
  );

  return {
    found: count,
    replaced
  };
}


// =========================================================
// Task zoeken in virtuele Loquiz tasklist
//
// Loquiz gebruikt cdk-virtual-scroll.
// Niet alle task-links staan dus tegelijk in de DOM.
//
// Deze functie:
// 1. kijkt eerst op de huidige scrollpositie;
// 2. scrollt vooruit door de virtuele lijst;
// 3. indien nodig begint hij opnieuw bovenaan;
// 4. klikt de task aan via de unieke task_id.
//
// GEEN page.goto() per task meer.
// =========================================================

async function openTaskFromList(
  page,
  gameId,
  taskId
) {
  const viewport = page.locator(
    'cdk-virtual-scroll-viewport'
  ).first();

  await viewport.waitFor({
    state: 'visible',
    timeout: 30000
  });

  const taskSelector =
    `a[href*="/games/edit/${gameId}/creator?task=${taskId}"]`;

  // Eerst zoeken vanaf huidige scrollpositie.
  // Als de task daarboven staat, doen we daarna een tweede
  // zoekronde vanaf het begin van de lijst.
  for (let pass = 0; pass < 2; pass++) {

    if (pass === 1) {
      await viewport.evaluate(
        element => {
          element.scrollTop = 0;
        }
      );

      await page.waitForTimeout(100);
    }

    for (let step = 0; step < 100; step++) {

      const taskLink = page
        .locator(taskSelector)
        .first();

      if (
        await taskLink.count() > 0
      ) {
        await taskLink.scrollIntoViewIfNeeded();

        console.log(
          `🔎 Task gevonden in tasklist: ${taskId}`
        );

        await taskLink.click();

        return;
      }

      const scrollState =
        await viewport.evaluate(
          element => ({
            scrollTop: element.scrollTop,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight
          })
        );

      const atBottom =
        scrollState.scrollTop +
        scrollState.clientHeight >=
        scrollState.scrollHeight - 5;

      if (atBottom) {
        break;
      }

      await viewport.evaluate(
        element => {
          const distance = Math.max(
            element.clientHeight * 0.85,
            1200
          );

          element.scrollBy(
            0,
            distance
          );
        }
      );

      // CDK virtual scroll even gelegenheid geven
      // om de volgende rows in de DOM te zetten.
      await page.waitForTimeout(75);
    }
  }

  throw new Error(
    `❌ Task ${taskId} niet gevonden in Loquiz tasklist`
  );
}


// =========================================================
// Main route
// =========================================================

app.post('/run', (req, res) => {
  console.log(
    '🚀 Ontvangen POST-verzoek bij /run'
  );

  const {
    entry_id,
    webhook_url,
    username,
    password,
    game_id,
    tasks
  } = req.body;

  const apiKey =
    req.headers['x-api-key'];

  // 🔐 API-key
  if (
    apiKey !== process.env.API_KEY
  ) {
    console.warn(
      '⛔ Ongeldige API key'
    );

    return res.status(403).json({
      success: false,
      error: 'Unauthorized'
    });
  }

  // ✅ Vereiste velden
  if (
    !entry_id ||
    !webhook_url ||
    !username ||
    !password ||
    !game_id ||
    !tasks ||
    !tasks.length
  ) {
    console.error(
      '❌ Ontbrekende velden in request'
    );

    return res.status(400).json({
      success: false,
      error: 'Verplichte velden ontbreken'
    });
  }

  // Direct antwoord aan WordPress
  res.json({
    success: true,
    message: 'Script gestart op achtergrond'
  });


  // =======================================================
  // Browseractie
  // =======================================================

  (async () => {
    let browser;

    try {

      browser = await chromium.launch({
        headless: true,

        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox'
        ],

        chromiumSandbox: false
      });

      console.log(
        '🌐 Chromium succesvol gestart'
      );


      // ===================================================
      // Eén browsercontext + één pagina voor de hele run
      // ===================================================

      const context =
        await browser.newContext();


      // ===================================================
      // MEMORY / PERFORMANCE OPTIMALISATIE
      //
      // Niet nodig voor de automatisering:
      // - afbeeldingen
      // - fonts
      // - video/audio
      // - analytics/tracking
      //
      // Loquiz JavaScript, API-calls, CSS en HTML blijven
      // gewoon functioneren.
      // ===================================================

      await context.route(
        '**/*',
        async route => {
          const request =
            route.request();

          const resourceType =
            request.resourceType();

          const url =
            request.url();

          if (
            resourceType === 'image' ||
            resourceType === 'media' ||
            resourceType === 'font'
          ) {
            return route.abort();
          }

          if (
            url.includes(
              'googletagmanager.com'
            ) ||
            url.includes(
              'google-analytics.com'
            ) ||
            url.includes(
              'connect.facebook.net'
            ) ||
            url.includes(
              'facebook.com/tr'
            )
          ) {
            return route.abort();
          }

          return route.continue();
        }
      );


      const page =
        await context.newPage();

      page.setDefaultTimeout(30000);

      page.setDefaultNavigationTimeout(
        60000
      );


      // ===================================================
      // Login
      // ===================================================

      console.log(
        '🌐 Ga naar inlogpagina...'
      );

      await page.goto(
        'https://creator.loquiz.com/login',
        {
          waitUntil: 'domcontentloaded'
        }
      );

      console.log(
        '🔐 Inloggen...'
      );

      const emailField =
        page.locator(
          'app-input[formcontrolname="email"] input'
        );

      const passwordField =
        page.locator(
          'app-input[formcontrolname="password"] input'
        );

      await emailField.waitFor({
        state: 'visible',
        timeout: 10000
      });

      await passwordField.waitFor({
        state: 'visible',
        timeout: 10000
      });

      await emailField.fill(
        username
      );

      await passwordField.fill(
        password
      );

      await Promise.all([
        page.waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: 30000
        }),
        page.click(
          'button[type="submit"]'
        )
      ]);

      console.log(
        '✅ Ingelogd'
      );


      // ===================================================
      // Game één keer openen
      // ===================================================

      const creatorUrl =
        `https://creator.loquiz.com/games/edit/${game_id}/creator`;

      console.log(
        '🎮 Open game Creator:',
        creatorUrl
      );

      await page.goto(
        creatorUrl,
        {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        }
      );


      // Tasklist moet geladen zijn.
      const taskViewport =
        page.locator(
          'cdk-virtual-scroll-viewport'
        ).first();

      await taskViewport.waitFor({
        state: 'visible',
        timeout: 60000
      });

      console.log(
        '✅ Game geladen en tasklist zichtbaar'
      );


      // ===================================================
      // Alle tasks verwerken binnen DEZELFDE Creator
      // ===================================================

      for (
        const [i, task]
        of tasks.entries()
      ) {

        console.log(
          `🔁 Taak ${i + 1}/${tasks.length}: ${task.task_id}`
        );


        // ===============================================
        // Task zoeken en openen vanuit bestaande tasklist
        // ===============================================

        await openTaskFromList(
          page,
          game_id,
          task.task_id
        );


        // ===============================================
        // Taskdialog
        // ===============================================

        const taskDialog =
          page.locator(
            'app-dialog-box'
          ).last();

        await taskDialog.waitFor({
          state: 'visible',
          timeout: 30000
        });

        console.log(
          '✅ Taakdialoog geopend'
        );


        // ===============================================
        // Vraagtekst
        // ===============================================

        if (task.content) {

          const editor =
            taskDialog.locator(
              'app-html-editor[formcontrolname="text"] .ql-editor[contenteditable="true"]'
            );

          await editor.waitFor({
            state: 'visible',
            timeout: 30000
          });

          const newText =
            decodeHtmlEntities(
              String(task.content)
            );

          await editor.fill(
            newText
          );

          console.log(
            '📝 Editor gevuld:',
            newText
          );
        }


        // ===============================================
        // Antwoorden
        //
        // Bij informatietaken wordt direct vastgesteld
        // dat app-answers-input niet bestaat.
        // Geen 10 seconden timeout meer.
        // ===============================================

        if (
          task.answers_same === 'Yes'
        ) {

          await vulAntwoorden(
            taskDialog,
            {
              option1:
                task.static_multiple_choice_answer_good,

              option2:
                task.static_multiple_choice_answer_wrong1,

              option3:
                task.static_multiple_choice_answer_wrong2,

              option4:
                task.static_multiple_choice_answer_wrong3
            }
          );

          console.log(
            '✅ Statische antwoorden verwerkt'
          );

        } else {

          await vulAntwoorden(
            taskDialog,
            {
              option1:
                task.answer_good_name,

              option2:
                task.answer_wrong1_name,

              option3:
                task.answer_wrong2_name,

              option4:
                task.answer_wrong3_name
            }
          );

          console.log(
            '✅ Antwoorden verwerkt'
          );
        }


        // ===============================================
        // Commentaar
        // ===============================================

        if (
          task.comment &&
          task.comment.trim() !== ''
        ) {

          console.log(
            '💬 Commentaar toevoegen'
          );

          const commentsButton =
            taskDialog.getByRole(
              'tab',
              {
                name: 'Comments',
                exact: true
              }
            );

          await commentsButton.waitFor({
            state: 'visible',
            timeout: 10000
          });

          await commentsButton.click();

          const commentEditor =
            taskDialog.locator(
              'app-html-editor[formcontrolname="correctComment"] .ql-editor[contenteditable="true"]'
            );

          await commentEditor.waitFor({
            state: 'visible',
            timeout: 10000
          });

          await commentEditor.fill(
            task.comment
          );

          console.log(
            '💬 Comment ingevuld:',
            task.comment
          );
        }


        // ===============================================
        // Save as copy
        // ===============================================

        const saveCopyButton =
          taskDialog
            .locator(
              'app-dialog-box-footer'
            )
            .getByRole(
              'button',
              {
                name: 'Save as copy',
                exact: true
              }
            );

        await saveCopyButton.waitFor({
          state: 'visible',
          timeout: 10000
        });

        await saveCopyButton.click();

        console.log(
          '💾 Save as copy geklikt'
        );


        // ===============================================
        // Wachten totdat taskdialog daadwerkelijk weg is
        // ===============================================

        await taskDialog.waitFor({
          state: 'hidden',
          timeout: 30000
        });

        console.log(
          '✅ Dialoog gesloten na Save as copy'
        );


        // ===============================================
        // De tasklist moet weer beschikbaar zijn voordat
        // de volgende taak wordt gezocht.
        // ===============================================

        await taskViewport.waitFor({
          state: 'visible',
          timeout: 30000
        });
      }


      // ===================================================
      // ALLE TASKS KLAAR
      //
      // Nu pas één keer de volledige game opslaan.
      // ===================================================

      console.log(
        '💾 Alle tasks verwerkt — game wordt nu opgeslagen'
      );


      const finalSaveButton =
        page
          .locator(
            '.navbar-end'
          )
          .getByRole(
            'button',
            {
              name: 'Save',
              exact: true
            }
          );


      await finalSaveButton.waitFor({
        state: 'visible',
        timeout: 30000
      });


      // Wacht totdat Save enabled is.
      await page.waitForFunction(
        () => {
          const buttons =
            [
              ...document.querySelectorAll(
                '.navbar-end button.btn-primary'
              )
            ];

          const button =
            buttons.find(
              btn =>
                btn.textContent.trim() ===
                'Save'
            );

          return (
            button &&
            !button.disabled
          );
        },
        null,
        {
          timeout: 30000
        }
      );


      console.log(
        '💾 Eind-saveknop is beschikbaar'
      );


      await finalSaveButton.click();


      console.log(
        '✅ Eind-save uitgevoerd'
      );


      // Na succesvolle Save wordt de knop disabled.
      await page.waitForFunction(
        () => {
          const buttons =
            [
              ...document.querySelectorAll(
                '.navbar-end button.btn-primary'
              )
            ];

          const button =
            buttons.find(
              btn =>
                btn.textContent.trim() ===
                'Save'
            );

          return (
            button &&
            button.disabled
          );
        },
        null,
        {
          timeout: 30000
        }
      );


      console.log(
        '✅ Save bevestigd door Loquiz'
      );


      // ===================================================
      // Placeholder-check
      // ===================================================

      try {

        const {
          ok,
          found
        } =
          await checkResultsPlaceholders(
            page,
            game_id
          );


        if (!ok) {

          console.warn(
            '⚠️ Placeholder-check FAALT. Niet-vervangen placeholders gevonden.'
          );


          const esc = s =>
            String(s).replace(
              /[&<>]/g,
              c => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;'
              }[c])
            );


          const subject =
            `⚠️ Warning: Loquiz game ${game_id} niet goed geconfigureerd!`;


          const itemsHtml =
            found
              .map(
                f => (
                  `<li style="margin-bottom:10px">
                    <code>${esc(f.placeholder)}</code>
                    <div style="font-family:monospace;background:#f6f8fa;padding:10px;border-radius:6px;white-space:nowrap;overflow:auto">
                      ${esc(f.context)}
                    </div>
                  </li>`
                )
              )
              .join('');


          const html = `
            <p>
              Na het verwerken van de taken zijn er nog placeholders aangetroffen op
              <a href="https://results.loquiz.com/${game_id}/answers" target="_blank" rel="noreferrer">
                results.loquiz.com/${game_id}/answers
              </a>:
            </p>

            <ul>
              ${itemsHtml}
            </ul>

            <p>
              Graag controleren en opnieuw draaien.
            </p>
          `;


          await sendWarningViaBrevoAPI({
            subject,
            html
          });


          console.warn(
            '⏹ WP-callback overgeslagen vanwege placeholder-fouten.'
          );

        } else {

          console.log(
            '✅ Placeholder-check OK — alle placeholders zijn vervangen.'
          );


          // ===============================================
          // Callback WordPress
          // ===============================================

          console.log(
            '➡️ Callback wordt verstuurd naar:',
            webhook_url
          );

          console.log(
            '➡️ Payload:',
            JSON.stringify({
              entry_id
            })
          );


          const callbackResponse =
            await fetch(
              webhook_url,
              {
                method: 'POST',

                headers: {
                  'Content-Type':
                    'application/json'
                },

                body:
                  JSON.stringify({
                    entry_id
                  })
              }
            );


          const text =
            await callbackResponse.text();


          console.log(
            `✅ WordPress response (${callbackResponse.status}):`,
            text
          );


          if (
            !callbackResponse.ok
          ) {
            throw new Error(
              `❌ WP callback mislukt met status ${callbackResponse.status}`
            );
          }
        }

      } catch (e) {

        console.error(
          '❌ Fout tijdens placeholder-check / e-mail:',
          e
        );
      }


    // =====================================================
    // Algemene runtime error
    // =====================================================

    } catch (err) {

      console.error(
        '❌ Fout tijdens uitvoeren:',
        err
      );


      try {

        const esc = s =>
          String(s ?? '')
            .replace(
              /[&<>]/g,
              c => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;'
              }[c])
            );


        const subject =
          `❌ Error in Loquiz Playwright script (game ${game_id}, entry ${entry_id})`;


        const stack =
          err?.stack
            ? String(err.stack)
            : String(err);


        const html = `
          <p>
            <strong>
              Er is een fout opgetreden tijdens het uitvoeren van het Playwright-script.
            </strong>
          </p>

          <p>
            <strong>Entry ID:</strong>
            ${esc(entry_id)}
            <br/>

            <strong>Game ID:</strong>
            ${esc(game_id)}
            <br/>

            <strong>Tasks:</strong>
            ${Array.isArray(tasks) ? tasks.length : 0}
          </p>

          <p>
            <strong>Error message:</strong>
          </p>

          <pre style="font-family:monospace;background:#f6f8fa;padding:12px;border-radius:8px;white-space:pre-wrap;overflow:auto">${esc(stack)}</pre>

          <p>
            <strong>Webhook URL:</strong>
            ${esc(webhook_url || '')}
          </p>
        `;


        await sendWarningViaBrevoAPI({
          subject,
          html
        });

      } catch (mailErr) {

        console.error(
          '❌ Kon error-mail via Brevo niet versturen:',
          mailErr
        );
      }


    } finally {

      if (browser) {

        await browser.close();

        console.warn(
          '⚠️ Browser gesloten'
        );
      }
    }

  })();
});


// =========================================================
// Health endpoint
// =========================================================

app.get('/', (req, res) => {
  res.send('👋 Hello!');
});


app.listen(port, () => {
  console.log(
    `🌍 Server draait op poort ${port}`
  );
});
