<p align="center">
  <img src="assets/smartduck-hero-banner.svg" alt="SmartDuck: An IoT Web-Based Balut and Penoy Production Monitoring and Egg Incubation System for Uno Duck Farm" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Firebase-DD2C00?style=for-the-badge&logo=firebase&logoColor=white" alt="Firebase">
  <img src="https://img.shields.io/badge/PHP-777BB4?style=for-the-badge&logo=php&logoColor=white" alt="PHP">
  <img src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Vercel">
  <img src="https://img.shields.io/badge/ESP32-E7352C?style=for-the-badge&logo=espressif&logoColor=white" alt="ESP32">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5">
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3">
  <img src="https://img.shields.io/badge/No%20secrets-included-132031?style=for-the-badge&logo=letsencrypt&logoColor=white" alt="No secrets included">
</p>

---

## <img src="assets/badges/egg.svg" width="30" height="30" align="absmiddle" alt=""> About

SmartDuck was made for Uno Duck Farm in Sta. Catalina Sur, Candelaria, Quezon, which
produces balut and penoy. It is an incubator for duck eggs that is watched and controlled
from a website.
A DHT22 sensor inside the incubator reads the temperature and humidity every 2 seconds,
and an ESP32 board keeps the eggs in the right conditions. During a batch it:

- turns on the heater and light when the temperature drops to 37.3 °C, and off at 37.7 °C
- runs the cooling fan when the temperature reaches 37.7 °C, until it is back at 37.3 °C
- turns the eggs once every 4 hours
- lowers the egg tray on Day 7 and Day 14 for candling, with the candling light on,
  and raises it again after 10 minutes
- alerts the staff when the temperature or humidity goes out of range

Administrators and users follow every batch on a web dashboard, from the day the eggs
are set to hatch day. They can also switch each part ON, OFF or AUTO by hand and
download reports.

This repository has the website (frontend) and only a small part of the backend. The PHP
API (`api/`) and the ESP32 firmware are not included.

> [!IMPORTANT]
> **There is no sensitive information in this repository.** No API keys, no passwords,
> no `.env` files, no Firebase service-account key, no email or SMS credentials and no
> database files. The server reads its keys from the computer it runs on, so none of
> them are written in the code.

---

## <img src="assets/badges/database.svg" width="30" height="30" align="absmiddle" alt=""> Database

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/firebase/firebase-original.svg" width="80" alt="Firebase logo">
      <h3>Firebase</h3>
      <p><b>Online database (Realtime Database)</b></p>
      <p>Stores the accounts, batches, sensor readings, incubator parts, alerts, reports
      and history. Only the server talks to it. The website and the ESP32 never do.</p>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/json/json-original.svg" width="80" alt="JSON logo">
      <h3>Local JSON file</h3>
      <p><b>Backup on the computer running SmartDuck</b></p>
      <p>Keeps SmartDuck working when Firebase cannot be reached, so the dashboard and
      the incubator keep going during an outage.</p>
    </td>
  </tr>
</table>

The tables and how they connect are in [docs/smartduck-erd.md](docs/smartduck-erd.md).

---

## <img src="assets/badges/code.svg" width="30" height="30" align="absmiddle" alt=""> Languages used

<p align="center">
  <img src="https://skillicons.dev/icons?i=js,html,css,php&theme=dark" alt="JavaScript, HTML, CSS, PHP">
</p>

| Language | Type | Used for |
| --- | --- | --- |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/javascript/javascript-original.svg" width="20"> **JavaScript** | Programming language | The dashboard, live graphs, part controls and the PDF and Excel reports |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/html5/html5-original.svg" width="20"> **HTML5** | Markup language | The administrator, user and sign-in pages |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/css3/css3-original.svg" width="20"> **CSS3** | Style sheet language | Layout, colors and the phone layout |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/php/php-original.svg" width="20"> **PHP** | Programming language | The server: sign-in, batches, alerts, reports and the ESP32 check-in |

---

## <img src="assets/badges/gauge.svg" width="30" height="30" align="absmiddle" alt=""> What SmartDuck monitors

| | Reading | Sensor | What SmartDuck does with it |
| :---: | --- | --- | --- |
| <img src="assets/badges/thermometer-simple.svg" width="38" height="38" alt=""> | **Temperature** | DHT22 | Turns on the heater at 37.3 °C and the fan at 37.7 °C, alerts when it leaves that range |
| <img src="assets/badges/drop-half-bottom.svg" width="38" height="38" alt=""> | **Humidity** | DHT22 | Alerts the staff when it goes below 50% or above 70% |
| <img src="assets/badges/toggle-right.svg" width="38" height="38" alt=""> | **Part status** | ESP32 | Shows if each part is on, off or not running, and sends an SMS when it changes |
| <img src="assets/badges/calendar-check.svg" width="38" height="38" alt=""> | **Batch day** | Server clock | Counts the days of each batch, with candling on Day 7 and Day 14 |

## <img src="assets/badges/toggle-right.svg" width="30" height="30" align="absmiddle" alt=""> What SmartDuck controls

Every part can be set to **ON**, **OFF** or **AUTO** from the dashboard. In AUTO:

| | Part | How it runs |
| :---: | --- | --- |
| <img src="assets/badges/fire.svg" width="38" height="38" alt=""> | **Heater and incubator light** | On at 37.3 °C, off at 37.7 °C |
| <img src="assets/badges/fan.svg" width="38" height="38" alt=""> | **Cooling fan** | On at 37.7 °C, off once it is back at 37.3 °C |
| <img src="assets/badges/arrows-clockwise.svg" width="38" height="38" alt=""> | **Egg rolling** | One full turn every 4 hours |
| <img src="assets/badges/arrows-down-up.svg" width="38" height="38" alt=""> | **Actuators** | Lower the tray on Day 7 and Day 14 for candling, then raise it after 10 minutes |
| <img src="assets/badges/lightbulb-filament.svg" width="38" height="38" alt=""> | **Candling light** | On while the tray is down for candling |

---

## <img src="assets/badges/list-checks.svg" width="30" height="30" align="absmiddle" alt=""> Features

<table>
  <tr>
    <td width="50%" valign="top">

<img src="assets/badges/chart-line-up.svg" width="46" height="46" alt="">

### Monitoring
- Live temperature and humidity
- Graphs from realtime up to several hours, with the average, lowest and highest reading
- Status of every incubator part

    </td>
    <td width="50%" valign="top">

<img src="assets/badges/egg-crack.svg" width="46" height="46" alt="">

### Batches and candling
- Start a batch with the number of eggs and the day they were set
- Day count and expected hatch date
- Candling on Day 7 and Day 14, with the removed eggs recorded
- Egg turning schedule

    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">

<img src="assets/badges/file-text.svg" width="46" height="46" alt="">

### Reports and history
- Batch, alert and production reports in PDF and Excel
- History of readings, alerts and activity
- Hatched and unhatched eggs and the hatch rate of each batch

    </td>
    <td width="50%" valign="top">

<img src="assets/badges/bell-ringing.svg" width="46" height="46" alt="">

### Alerts
- Alerts on the dashboard when the temperature or humidity is out of range
- SMS when a part turns on, turns off or stops running
- Notifications when candling starts and when the tray goes back up

    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">

<img src="assets/badges/shield-check.svg" width="46" height="46" alt="">

### Accounts
- Administrator and User accounts
- Sign-up and password reset with a code sent by email
- Strong password rules, and passwords are stored hashed

    </td>
    <td width="50%" valign="top">

<img src="assets/badges/devices.svg" width="46" height="46" alt="">

### Where to use it
- On a computer or a phone
- The ESP32 keeps the heater and fan running on its own, even without internet

    </td>
  </tr>
</table>

---

## <img src="assets/badges/tree-structure.svg" width="30" height="30" align="absmiddle" alt=""> How it works

<p align="center">
  <img src="assets/smartduck-how-it-works-diagram.svg" alt="How SmartDuck works, from the sensor to the website" width="100%">
</p>

1. The DHT22 sensor reads the temperature and humidity inside the incubator every 2 seconds.
2. The ESP32 runs the incubator parts through relays and an L298N motor driver: the heater
   and light, the cooling fan, egg rolling, the two tray actuators and the
   candling light. It keeps the heater and fan rules running on its own.
3. Every few seconds the ESP32 checks in with the SmartDuck server over HTTPS. It sends the
   readings and the state of each part, and picks up any ON, OFF or AUTO command from the
   dashboard.
4. The server runs on Vercel. It saves everything in Firebase, sends SMS alerts and the
   email sign-in codes, and builds the data for the reports.
5. The website shows the live readings, the batches and the history, for administrators
   and users, on a computer or a phone.

---

## <img src="assets/badges/stack.svg" width="30" height="30" align="absmiddle" alt=""> Tech stack

<p align="center">
  <img src="https://skillicons.dev/icons?i=php,firebase,vercel,arduino&theme=dark" alt="PHP, Firebase, Vercel, Arduino">
</p>

| Part | Built with |
| --- | --- |
| **Backend** | PHP 8.3, one API file (not included here) |
| **Database** | Firebase Realtime Database, with a local JSON backup |
| **Website hosting** | Vercel |
| **Device** | ESP32 with a DHT22 sensor, relays and an L298N motor driver (firmware not included here) |
| **Frontend** | HTML5, CSS3 and plain JavaScript, no framework |
| **Email and SMS** | Email sign-in codes and an SMS gateway, both sent by the server |
| **Reports** | PDF and Excel (.xlsx) files made in the browser |

---

## <img src="assets/badges/folder-simple.svg" width="30" height="30" align="absmiddle" alt=""> Project structure

```text
smartduck-source-code/
├── admin/                 # Administrator pages: dashboard, monitoring, batches,
│                          # candling, history, users, settings
├── user/                  # User pages: dashboard, monitoring, batches, candling,
│                          # history, reports, profile, settings
├── assets/                # Logo, sign-in background, team photos and README images
├── docs/                  # Database tables (ERD and dbdiagram)
├── firebase/
│   └── database.rules.json  # Firebase rules: closed to everyone but the server
├── loginform.html         # Sign-in, sign-up and password reset
├── script.js              # The whole dashboard app
├── styles.css             # Desktop styles
├── mobile.css             # Phone layout
├── mobile-shell.js        # Phone navigation
├── auth-guard.js          # Sends signed-out visitors back to the sign-in page
├── index.php              # Serves the sign-in page at the site root
└── router.php             # Clean URLs for PHP's local server
```

---

## <img src="assets/badges/users-three.svg" width="30" height="30" align="absmiddle" alt=""> Team

<p align="center">
  <img src="assets/smartduck-team-card.svg" alt="The SmartDuck team: Mac Dave Biago, Leader; Sophia Bianca Bihasa, Design; Baby April Lavarro, Documentation; Chenie Polloso, Documentation" width="100%">
</p>

---

## <img src="assets/badges/paper-plane-tilt.svg" width="30" height="30" align="absmiddle" alt=""> Contact

This repository only has part of the SmartDuck source code.
If you want the full source code, or you have a question about the project,
message me on Telegram or Facebook. Just tap a button below.

<p align="center">
  <a href="https://t.me/hachi0427">
    <img src="https://img.shields.io/badge/Telegram-Tap%20to%20chat-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Tap to chat on Telegram">
  </a>
  <a href="https://web.facebook.com/chris.benedict.00">
    <img src="https://img.shields.io/badge/Facebook-Tap%20to%20chat-1877F2?style=for-the-badge&logo=facebook&logoColor=white" alt="Tap to chat on Facebook">
  </a>
</p>

---

<p align="center">
  <img src="assets/logo-transparent.png" width="120" alt="SmartDuck logo">
  <br>
  <sub>SmartDuck: An IoT Web-Based Balut and Penoy Production Monitoring and Egg Incubation System for Uno Duck Farm</sub>
</p>
