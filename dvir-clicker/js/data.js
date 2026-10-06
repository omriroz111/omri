// Game data and balance for Dvir Clicker: buildings, upgrades, achievements,
// skin unlock rules. Pure data plus small predicate functions; no DOM access.
(() => {
  "use strict";

  // Repeatable purchases. click: added to every click. sec: added per second.
  // The first nine ids match v1 saves, so existing progress carries over.
  const BUILDINGS = [
    { id: "finger", icon: "👆", name: "אצבע מאומנת", click: 1, base: 15 },
    { id: "auto", icon: "🤖", name: "קליקר אוטומטי", sec: 1, base: 50 },
    { id: "clone", icon: "👯", name: "שיבוט של דביר", sec: 6, base: 400 },
    { id: "iron", icon: "💪", name: "יד ברזל", click: 12, base: 2000 },
    { id: "class", icon: "🏫", name: "כל הכיתה לוחצת", sec: 40, base: 5000 },
    { id: "factory", icon: "🏭", name: "מפעל דבירים", sec: 200, base: 40000 },
    { id: "golden", icon: "✨", name: "אצבע זהב", click: 400, base: 250000 },
    { id: "space", icon: "🛸", name: "דביר בחלל", sec: 1200, base: 400000 },
    { id: "empire", icon: "🏰", name: "אימפריית דביר", sec: 8000, base: 5e6 },
    { id: "island", icon: "🏝️", name: "אי של דביר", sec: 50000, base: 6e7 },
    { id: "cosmic", icon: "☄️", name: "אצבע קוסמית", click: 25000, base: 2.5e8 },
    { id: "galaxy", icon: "🌌", name: "גלקסיית דביר", sec: 3e5, base: 8e8 },
    { id: "time", icon: "⏳", name: "מכונת זמן", sec: 2e6, base: 1.2e10 },
    { id: "multiverse", icon: "🌀", name: "מולטי-ורס של דביר", sec: 1.5e7, base: 2e11 },
  ];

  // ---------------------------------------------------------------
  // One-time upgrades
  // ---------------------------------------------------------------
  const UPGRADES = [];

  // Every building gets five x2 tiers, unlocked by how many you own.
  const TIERS = [
    { name: "טורבו", need: 1, mult: 10 },
    { name: "מגה", need: 10, mult: 50 },
    { name: "אולטרה", need: 25, mult: 500 },
    { name: "היפר", need: 50, mult: 5000 },
    { name: "אגדי", need: 100, mult: 50000 },
  ];
  for (const b of BUILDINGS) {
    TIERS.forEach((t, i) => {
      UPGRADES.push({
        id: `${b.id}-${i + 1}`,
        kind: "building",
        target: b.id,
        tier: i + 1,
        icon: b.icon,
        name: `${b.name} ${t.name}`,
        desc: `פי 2 ל${b.name}`,
        cost: b.base * t.mult,
        unlock: (s) => (s.owned[b.id] || 0) >= t.need,
      });
    });
  }

  // Clicks also earn a slice of production.
  [
    [100, 5e4, "לחיצה חכמה"],
    [1000, 5e6, "לחיצה מבריקה"],
    [5000, 5e8, "לחיצה גאונית"],
    [20000, 5e10, "לחיצה מושלמת"],
    [60000, 5e12, "לחיצה אלוהית"],
  ].forEach(([need, cost, name], i) => {
    UPGRADES.push({
      id: `click-${i + 1}`,
      kind: "clickPct",
      value: 0.01,
      tier: i + 1,
      icon: "🖱️",
      name,
      desc: "כל לחיצה מקבלת גם 1% מהייצור לשנייה",
      cost,
      unlock: (s) => s.totalClicks >= need,
    });
  });

  // Flat multipliers on all production.
  [
    ["cocoa", "☕", "שוקו חם", 1e5],
    ["pizza", "🍕", "פיצה משפחתית", 1e8],
    ["cake", "🎂", "עוגת יום הולדת", 1e11],
    ["rocket", "🚀", "דלק טילים", 1e14],
  ].forEach(([id, icon, name, cost]) => {
    UPGRADES.push({
      id: `global-${id}`,
      kind: "global",
      value: 1.25,
      icon,
      name,
      desc: "+25% לכל הייצור",
      cost,
      unlock: (s) => s.runEarned >= cost * 0.4,
    });
  });

  // Golden Dvir helpers.
  UPGRADES.push(
    {
      id: "gold-luck",
      kind: "goldenFreq",
      icon: "🍀",
      name: "מזל של דביר",
      desc: "דביר זהב מופיע פי 2 יותר",
      cost: 77777,
      unlock: (s) => s.golden >= 3,
    },
    {
      id: "gold-stay",
      kind: "goldenStay",
      icon: "⏱️",
      name: "דביר זהב עמיד",
      desc: "דביר זהב נשאר פי 2 יותר זמן",
      cost: 7777777,
      unlock: (s) => s.golden >= 7,
    },
    {
      id: "gold-long",
      kind: "buffLong",
      icon: "🔥",
      name: "טירוף ארוך",
      desc: "הבונוסים של דביר זהב נמשכים פי 2",
      cost: 777777777,
      unlock: (s) => s.golden >= 15,
    }
  );

  // ---------------------------------------------------------------
  // Achievements (each one adds +1% production)
  // c = live numbers from the game: perSec, combo, buildings, upgrades,
  // achievements, skins, skinsTotal, idle (seconds since last click).
  // ---------------------------------------------------------------
  const ACHIEVEMENTS = [];
  const ach = (id, icon, name, desc, test, secret = false) =>
    ACHIEVEMENTS.push({ id, icon, name, desc, test, secret });

  ach("c1", "👆", "הלחיצה הראשונה", "ללחוץ על דביר פעם אחת", (s) => s.totalClicks >= 1);
  ach("c100", "🔥", "מתחממים", "100 לחיצות", (s) => s.totalClicks >= 100);
  ach("c1k", "⚡", "אצבע זריזה", "1,000 לחיצות", (s) => s.totalClicks >= 1000);
  ach("c10k", "🤖", "מכונת לחיצות", "10,000 לחיצות", (s) => s.totalClicks >= 10000);
  ach("c50k", "🦾", "האצבע שלא נחה", "50,000 לחיצות", (s) => s.totalClicks >= 50000);
  ach("c100k", "🏅", "אגדת הלחיצות", "100,000 לחיצות", (s) => s.totalClicks >= 100000);

  ach("e1k", "💰", "אלף דבירים", "לאסוף 1,000 דבירים", (s) => s.totalEarned >= 1e3);
  ach("e100k", "💵", "עשירים!", "לאסוף 100,000 דבירים", (s) => s.totalEarned >= 1e5);
  ach("e1m", "💎", "מיליונר", "לאסוף מיליון דבירים", (s) => s.totalEarned >= 1e6);
  ach("e100m", "🏦", "מאה מיליון", "לאסוף 100 מיליון דבירים", (s) => s.totalEarned >= 1e8);
  ach("e1b", "🤑", "מיליארדר", "לאסוף מיליארד דבירים", (s) => s.totalEarned >= 1e9);
  ach("e1t", "🪐", "טריליונר", "לאסוף טריליון דבירים", (s) => s.totalEarned >= 1e12);
  ach("e1qa", "🌠", "מעבר לדמיון", "לאסוף קוודריליון דבירים", (s) => s.totalEarned >= 1e15);

  ach("p10", "🌱", "זה מתחיל לזוז", "10 דבירים לשנייה", (s, c) => c.perSec >= 10);
  ach("p100", "⚙️", "פס ייצור", "100 דבירים לשנייה", (s, c) => c.perSec >= 100);
  ach("p1k", "🏭", "מפעל רציני", "1,000 דבירים לשנייה", (s, c) => c.perSec >= 1e3);
  ach("p10k", "🏗️", "תעשייה", "10,000 דבירים לשנייה", (s, c) => c.perSec >= 1e4);
  ach("p100k", "🌍", "מעצמה", "100,000 דבירים לשנייה", (s, c) => c.perSec >= 1e5);
  ach("p1m", "🏰", "אימפריה", "מיליון דבירים לשנייה", (s, c) => c.perSec >= 1e6);
  ach("p100m", "🌌", "קוסמי", "100 מיליון דבירים לשנייה", (s, c) => c.perSec >= 1e8);

  ach("cb10", "💥", "קומבו!", "קומבו של 10", (s) => s.maxCombo >= 10);
  ach("cb25", "🌶️", "על האש", "קומבו של 25", (s) => s.maxCombo >= 25);
  ach("cb50", "☄️", "בלתי ניתן לעצירה", "קומבו של 50", (s) => s.maxCombo >= 50);
  ach("cb100", "🌩️", "אצבעות של ברק", "קומבו של 100", (s) => s.maxCombo >= 100);

  ach("b10auto", "🤖", "צבא רובוטים", "10 קליקרים אוטומטיים", (s) => (s.owned.auto || 0) >= 10);
  ach("b100", "🧱", "בנאי", "100 מבנים בסך הכול", (s, c) => c.buildings >= 100);
  ach("b250", "🏗️", "קבלן", "250 מבנים בסך הכול", (s, c) => c.buildings >= 250);
  ach("b500", "🏙️", "טייקון", "500 מבנים בסך הכול", (s, c) => c.buildings >= 500);
  ach("bmulti", "🌀", "דביר בכל היקום", "לקנות מולטי-ורס של דביר", (s) => (s.owned.multiverse || 0) >= 1);

  ach("u10", "🔧", "משדרג", "10 שדרוגים", (s, c) => c.upgrades >= 10);
  ach("u30", "🛠️", "מכונאי", "30 שדרוגים", (s, c) => c.upgrades >= 30);
  ach("u60", "🧰", "מהנדס ראשי", "60 שדרוגים", (s, c) => c.upgrades >= 60);

  ach("g1", "🍀", "מזל!", "לתפוס דביר זהב", (s) => s.golden >= 1);
  ach("g7", "🪙", "ציידי זהב", "לתפוס 7 דבירי זהב", (s) => s.golden >= 7);
  ach("g27", "🏆", "קדחת הזהב", "לתפוס 27 דבירי זהב", (s) => s.golden >= 27);
  ach("g77", "👑", "זהב טהור", "לתפוס 77 דבירי זהב", (s) => s.golden >= 77);

  ach("crit1", "🎯", "לחיצת מזל", "לחיצה קריטית ראשונה", (s) => s.crits >= 1);
  ach("crit50", "🎰", "יד ברת מזל", "50 לחיצות קריטיות", (s) => s.crits >= 50);

  ach("r1", "🌟", "לידה מחדש", "לעשות לידה מחדש", (s) => s.rebirths >= 1);
  ach("r5", "🔁", "שוב ושוב", "5 לידות מחדש", (s) => s.rebirths >= 5);
  ach("r10", "♾️", "נצחי", "10 לידות מחדש", (s) => s.rebirths >= 10);
  ach("s10", "🔭", "אסטרונום", "10 כוכבים", (s) => s.stars >= 10);
  ach("s100", "✨", "שמיים מלאי כוכבים", "100 כוכבים", (s) => s.stars >= 100);

  ach("sk1", "🎨", "סטייל", "לקבל סקין חדש", (s, c) => c.skins >= 3);
  ach("skall", "👗", "פשניסטה", "לאסוף את כל הסקינים", (s, c) => c.skins >= c.skinsTotal);

  ach("night", "🦉", "ינשוף לילה", "לשחק בין חצות לחמש בבוקר", () => {
    const h = new Date().getHours();
    return h >= 0 && h < 5;
  }, true);
  ach("quiet", "🤫", "שקט בספרייה", "לכבות גם את הסאונד וגם את המוזיקה", (s) => !s.sound && !s.music, true);
  ach("patience", "🧘", "סבלנות", "5 דקות בלי ללחוץ, כשהדבירים ממשיכים לזרום", (s, c) => c.idle >= 300 && c.perSec > 0, true);
  ach("turbo", "🏎️", "אצבעות טורבו", "15 לחיצות בשנייה אחת", (s, c) => c.burst >= 15, true);

  // ---------------------------------------------------------------
  // Skins: how each frame / accessory is unlocked.
  // cost: buy with דבירים. ach: unlocked by an achievement. rebirths: after N rebirths.
  // ---------------------------------------------------------------
  const SKIN_RULES = {
    "frame:gold": { free: true },
    "frame:diamond": { cost: 1e6 },
    "frame:fire": { ach: "cb50" },
    "frame:neon": { ach: "g7" },
    "frame:rainbow": { cost: 1e9 },
    "frame:galaxy": { rebirths: 3 },
    "acc:none": { free: true },
    "acc:party": { cost: 5000 },
    "acc:shades": { cost: 1e5 },
    "acc:headphones": { cost: 2.5e6 },
    "acc:cap": { ach: "c10k" },
    "acc:crown": { cost: 1e8 },
    "acc:halo": { rebirths: 1 },
  };

  // Background accent per frame.
  const FRAME_ACCENTS = {
    gold: "#ffb627",
    diamond: "#7fe7ff",
    fire: "#ff5a1f",
    neon: "#ff3df0",
    rainbow: "#9b7bff",
    galaxy: "#6a4bff",
  };

  // Lifetime totals that trigger a celebration: 100, 500, 1000, 5000, ...
  const MILESTONES = [];
  for (let p = 100; p <= 1e30; p *= 10) MILESTONES.push(p, p * 5);

  window.DCData = { BUILDINGS, UPGRADES, ACHIEVEMENTS, SKIN_RULES, FRAME_ACCENTS, MILESTONES };
})();
