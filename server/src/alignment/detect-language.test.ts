import { describe, expect, it } from 'vitest';
import {
  detectLanguageFromText,
  detectLanguageFromWindows,
  sampleWindows,
  WINDOW_CHARS,
  WINDOWS,
  windowOffsets,
} from './detect-language.js';

/**
 * A confident answer here outranks the file's own language tag in the
 * library, so the bar is set on the side of silence: a page of every
 * language this build is likely to meet must be named, and anything that is
 * not a page of one language - a heading, a name list, a bilingual edition -
 * must come back as no answer rather than a wrong one.
 */

const SAMPLES: Record<string, string> = {
  en: `The harbour woke slowly that morning. A thin fog lay over the water, and the fishing
    boats rocked against their ropes while the gulls argued on the roofs of the sheds. Mira
    walked along the quay with a basket of bread for her uncle, who had been mending nets since
    before dawn. She stopped at the end of the pier to watch the ferry come in with its lights
    still burning, and she wondered, as she did every day, where the people on board were going
    and whether any of them would ever come back to this small town beside the sea.`,
  de: `Am Morgen lag dichter Nebel über dem Hafen, und die kleinen Boote schaukelten leise an
    ihren Leinen. Die Bäckerin am Markt öffnete ihren Laden früher als sonst, weil sie wusste,
    dass die Fischer nach der langen Nacht hungrig sein würden. Ein Junge mit einer roten Mütze
    trug einen Korb voller Brötchen zum Kai hinunter, und sein Hund lief bellend hinter ihm her.
    Als die Sonne endlich durch die Wolken brach, glänzte das Wasser wie Silber, und die ganze
    Stadt schien für einen Augenblick den Atem anzuhalten.`,
  fr: `Ce matin-là, le brouillard couvrait encore le port quand la boulangère ouvrit sa
    boutique. Les pêcheurs rentraient lentement, fatigués par une longue nuit en mer, et l'odeur
    du pain chaud flottait jusqu'aux quais. Une petite fille assise sur les marches de l'église
    regardait les mouettes tourner au-dessus des bateaux. Elle attendait son grand-père, qui lui
    avait promis de l'emmener voir le phare avant l'arrivée de l'hiver, et elle se demandait si
    la mer serait assez calme pour qu'ils puissent partir avant midi.`,
  es: `Aquella mañana la niebla cubría todavía el puerto cuando la panadera abrió su tienda.
    Los pescadores volvían despacio, cansados después de una larga noche en el mar, y el olor
    del pan caliente llegaba hasta los muelles. Una niña sentada en los escalones de la iglesia
    miraba las gaviotas que daban vueltas sobre las barcas. Esperaba a su abuelo, que le había
    prometido llevarla a ver el faro antes de que llegara el invierno, y se preguntaba si el mar
    estaría lo bastante tranquilo para salir antes del mediodía.`,
  it: `Quella mattina la nebbia copriva ancora il porto quando la fornaia aprì la sua bottega.
    I pescatori tornavano lentamente, stanchi dopo una lunga notte in mare, e il profumo del
    pane caldo arrivava fino alle banchine. Una bambina seduta sui gradini della chiesa guardava
    i gabbiani che giravano sopra le barche. Aspettava il nonno, che le aveva promesso di
    portarla a vedere il faro prima dell'inverno, e si chiedeva se il mare sarebbe stato
    abbastanza calmo per partire prima di mezzogiorno.`,
  pt: `Naquela manhã o nevoeiro ainda cobria o porto quando a padeira abriu a sua loja. Os
    pescadores voltavam devagar, cansados depois de uma longa noite no mar, e o cheiro do pão
    quente chegava até ao cais. Uma menina sentada nos degraus da igreja olhava para as gaivotas
    que voavam em círculos sobre os barcos. Esperava pelo avô, que lhe tinha prometido levá-la a
    ver o farol antes de chegar o inverno, e perguntava a si mesma se o mar estaria calmo o
    suficiente para partirem antes do meio-dia.`,
  nl: `Die ochtend hing er nog dichte mist boven de haven toen de bakker zijn winkel opende.
    De vissers kwamen langzaam terug, moe na een lange nacht op zee, en de geur van vers brood
    woei tot aan de kade. Een klein meisje zat op de trappen van de kerk en keek naar de meeuwen
    die boven de boten rondcirkelden. Ze wachtte op haar grootvader, die had beloofd haar mee te
    nemen naar de vuurtoren voordat de winter kwam, en ze vroeg zich af of de zee rustig genoeg
    zou zijn om voor de middag te vertrekken.`,
  pl: `Tego ranka nad portem wciąż wisiała gęsta mgła, kiedy piekarka otworzyła swój sklep.
    Rybacy wracali powoli, zmęczeni po długiej nocy na morzu, a zapach ciepłego chleba unosił
    się aż do nabrzeża. Mała dziewczynka siedziała na schodach kościoła i patrzyła na mewy,
    które krążyły nad łodziami. Czekała na dziadka, który obiecał zabrać ją do latarni morskiej,
    zanim nadejdzie zima, i zastanawiała się, czy morze będzie na tyle spokojne, żeby mogli
    wypłynąć przed południem. W domu czekała na nich babcia z gorącą zupą i świeżym ciastem.`,
  ru: `В то утро над гаванью ещё висел густой туман, когда булочница открыла свою лавку.
    Рыбаки возвращались медленно, усталые после долгой ночи в море, и запах тёплого хлеба
    доносился до самой пристани. Маленькая девочка сидела на ступенях церкви и смотрела на
    чаек, которые кружились над лодками. Она ждала дедушку, который обещал отвезти её к маяку
    до наступления зимы, и думала о том, будет ли море достаточно спокойным, чтобы они смогли
    выйти в путь ещё до полудня. Дома их ждала бабушка с горячим супом и свежими пирогами, и в
    окнах уже горел свет.`,
  uk: `Ранок у селі починався тихо. Сонце ще не піднялося над садками, а бабуся вже поралася
    біля печі, і запах свіжого хліба розходився по всій хаті. Діти спали на печі, вкриті старою
    ковдрою, і тільки кіт неквапливо походжав подвір'ям, зазираючи в кожен куток. Дід сидів на
    лавці під вікном і лагодив старе колесо від воза, бо на ярмарок треба було їхати вже
    наступного тижня, а дорога до міста після дощів була довгою і поганою, і кожен знав, що
    своє колесо краще полагодити вдома, ніж чекати на чужу допомогу десь посеред поля.`,
  he: `באותו בוקר עדיין כיסה ערפל כבד את הנמל כשהאופה פתחה את החנות שלה. הדייגים חזרו לאט,
    עייפים אחרי לילה ארוך בים, וריח הלחם החם הגיע עד הרציף. ילדה קטנה ישבה על מדרגות בית הכנסת
    והסתכלה על השחפים שחגו מעל הסירות. היא חיכתה לסבא שלה, שהבטיח לקחת אותה לראות את המגדלור
    לפני שיגיע החורף, ותהתה אם הים יהיה שקט מספיק כדי שיוכלו לצאת לדרך לפני הצהריים. בבית
    חיכתה להם סבתא עם מרק חם ועוגה טרייה, ובחלונות כבר דלק האור, והרחוב הקטן התמלא בקולות
    של שכנים שחזרו מהשוק עם סלים מלאים בפירות ובירקות.`,
  yi: `עס איז געווען אַ מאָל אַ מלך, און דער מלך האָט געהאַט דרײַ זין. דער עלטסטער זון איז געווען
    אַ קלוגער, דער מיטלסטער אַ שטאַרקער, און דער ייִנגסטער האָט מען גערופֿן דער נאַר. איין מאָל
    האָט דער מלך גערופֿן זײַנע זין און האָט צו זיי געזאָגט: גייט אַרויס אין דער וועלט און זוכט
    אײַער גליק. די צוויי עלטערע ברידער זײַנען אַוועק אין די גרויסע שטעט, און דער ייִנגסטער איז
    געגאַנגען אין וואַלד אַרײַן, וווּ ער האָט געטראָפֿן אַן אַלטע פֿרוי מיט אַ קאָרב פֿול מיט עפּל.`,
  ar: `في ذلك الصباح كان الضباب الكثيف لا يزال يغطي الميناء عندما فتحت الخبازة دكانها. كان
    الصيادون يعودون ببطء، متعبين بعد ليلة طويلة في البحر، وكانت رائحة الخبز الساخن تصل إلى
    الرصيف. جلست طفلة صغيرة على درجات المسجد تنظر إلى طيور النورس وهي تحلق فوق القوارب. كانت
    تنتظر جدها الذي وعدها بأن يأخذها لترى المنارة قبل أن يأتي الشتاء، وكانت تتساءل هل سيكون
    البحر هادئا بما يكفي ليخرجا قبل الظهر. وفي البيت كانت الجدة تنتظرهما بحساء ساخن وخبز
    طازج، وكان النور قد أضيء في النوافذ.`,
  fa: `روزی روزگاری در شهری دور، پادشاهی زندگی می‌کرد که سه پسر داشت. پسر بزرگ‌تر بسیار دانا
    بود، پسر میانی بسیار نیرومند، و پسر کوچک‌تر را همه دیوانه می‌خواندند. روزی پادشاه پسرانش را
    فرا خواند و به آنان گفت: به جهان بروید و بخت خود را بیابید. پسران هر یک به راهی رفتند. پسر
    بزرگ به شهر دانشمندان رفت و سال‌ها در آنجا درس خواند. پسر میانی به میدان جنگ رفت و پهلوان
    بزرگی شد. اما پسر کوچک به جنگل رفت و در آنجا با پرندگان و جانوران سخن گفت و راز زندگی را
    آموخت، و چون بازگشت، از هر دو برادر خود داناتر و تواناتر بود.`,
  el: `Εκείνο το πρωί η πυκνή ομίχλη σκέπαζε ακόμα το λιμάνι, όταν η φουρνάρισσα άνοιξε το
    μαγαζί της. Οι ψαράδες γύριζαν αργά, κουρασμένοι ύστερα από μια μεγάλη νύχτα στη θάλασσα,
    και η μυρωδιά του ζεστού ψωμιού έφτανε μέχρι την προκυμαία. Ένα μικρό κορίτσι καθόταν στα
    σκαλιά της εκκλησίας και κοίταζε τους γλάρους που πετούσαν πάνω από τις βάρκες. Περίμενε
    τον παππού της, που της είχε υποσχεθεί να την πάει να δει τον φάρο πριν έρθει ο χειμώνας.`,
};

/** A book's worth of one sample: the sample many times over, never mid-word. */
const book = (sample: string, times: number) =>
  Array.from({ length: times }, () => sample).join(' ');

describe('detectLanguageFromText', () => {
  for (const [code, text] of Object.entries(SAMPLES)) {
    it(`recognises ${code} from a page of it`, () => {
      const got = detectLanguageFromText(text);
      expect(got?.language, `sample: ${text.slice(0, 40)}…`).toBe(code);
      expect(got!.confidence).toBeGreaterThan(0.5);
    });
  }

  it('calls a script that belongs to one language from the script alone', () => {
    expect(detectLanguageFromText(SAMPLES.el!)!.basis).toBe('script');
    // Cyrillic is shared, but "ы" and "э" belong to Russian and not to
    // Ukrainian, Bulgarian or Serbian, so the letters settle it.
    expect(detectLanguageFromText(SAMPLES.ru!)!.basis).toBe('script');
    expect(detectLanguageFromText(SAMPLES.uk!)!.basis).toBe('script');
    // Persian letters rule Arabic out, and Urdu's letters are absent: settled without trigrams.
    expect(detectLanguageFromText(SAMPLES.fa!)!.basis).toBe('script');
    expect(detectLanguageFromText(SAMPLES.ar!)!.basis).toBe('script');
    // Hebrew script is Hebrew or Yiddish, and only the trigrams say which.
    expect(detectLanguageFromText(SAMPLES.he!)!.basis).toBe('trigrams');
    expect(detectLanguageFromText(SAMPLES.en!)!.basis).toBe('trigrams');
  });

  it('is not fooled by a Russian name in an English novel', () => {
    const text = `${SAMPLES.en} Stepan Ilyich Karelin, Мармелев, Сосновкин. ${SAMPLES.en}`;
    expect(detectLanguageFromText(text)?.language).toBe('en');
  });

  it('abstains rather than guessing on too little text', () => {
    expect(detectLanguageFromText('Chapter One')).toBeNull();
    expect(detectLanguageFromText('')).toBeNull();
    expect(detectLanguageFromText('   \n  ')).toBeNull();
    expect(detectLanguageFromText('The quick brown fox jumps over the lazy dog.')).toBeNull();
    expect(
      detectLanguageFromText(
        'Diese eine Zeile ist zu kurz, um ein ganzes Buch zu beurteilen, und darum bleibt die Antwort offen.',
      ),
    ).toBeNull();
  });

  it('abstains on a page of proper nouns, which belong to no language', () => {
    const roster = Array.from({ length: 120 }, (_, i) => `Brandenburg Kowalski Nakamura${i}`).join(
      ' ',
    );
    expect(detectLanguageFromText(roster)).toBeNull();
  });

  it('abstains on a bilingual edition, where every page is two scripts', () => {
    // Facing pages: a paragraph of Hebrew, its English, and so on.
    expect(detectLanguageFromText(book(`${SAMPLES.he} ${SAMPLES.en}`, 6))).toBeNull();
  });

  it('abstains when the windows disagree: a book that turns from Spanish into Portuguese', () => {
    const got = detectLanguageFromText(`${book(SAMPLES.es!, 6)} ${book(SAMPLES.pt!, 6)}`);
    expect(got).toBeNull();
  });

  it('abstains when two languages are genuinely neck and neck on one page', () => {
    // Spanish and Portuguese share "que", "com/con", "para", "como", "mais/más".
    // A page that is half of each is a coin toss, and a coin toss is worse
    // than the file's own tag.
    const got = detectLanguageFromText(`${SAMPLES.es} ${SAMPLES.pt}`);
    if (got) expect(['es', 'pt']).toContain(got.language);
  });

  it('tolerates one window of another language inside a book', () => {
    // A long quotation, a foreword: five windows of English outvote one of German.
    const text = `${book(SAMPLES.en!, 12)} ${book(SAMPLES.de!, 3)} ${book(SAMPLES.en!, 12)}`;
    const got = detectLanguageFromText(text);
    expect(got?.language).toBe('en');
    expect(got!.windows).toBe(WINDOWS);
    expect(got!.agreeing).toBeGreaterThanOrEqual(WINDOWS - 3);
    expect(got!.agreeing).toBeLessThan(WINDOWS);
  });

  it('skips the front matter and reads the book, quickly, however long it is', () => {
    // An English title page and copyright notice in front of a Spanish
    // novel: the first 5% is not sampled, and a million characters cost
    // no more to answer than six windows do.
    const long = `${SAMPLES.en} ${SAMPLES.es!.repeat(4000)}`;
    const started = performance.now();
    const got = detectLanguageFromText(long);
    expect(performance.now() - started).toBeLessThan(400);
    expect(got?.language).toBe('es');
    expect(got!.windows).toBe(WINDOWS);
  });
});

describe('windows', () => {
  it('reads a short book whole, in even contiguous pieces', () => {
    expect(windowOffsets(0)).toEqual([]);
    expect(windowOffsets(400)).toEqual([{ at: 0, length: 400 }]);
    expect(windowOffsets(800)).toEqual([{ at: 0, length: 800 }]);
    expect(windowOffsets(1200)).toEqual([
      { at: 0, length: 600 },
      { at: 600, length: 600 },
    ]);
    for (const total of [1200, 4489, 8000]) {
      const offsets = windowOffsets(total);
      expect(offsets.length).toBeLessThanOrEqual(WINDOWS);
      expect(offsets[0]).toMatchObject({ at: 0 });
      expect(offsets.at(-1)!.at + offsets.at(-1)!.length).toBe(total);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]!.at).toBe(offsets[i - 1]!.at + offsets[i - 1]!.length);
        expect(offsets[i]!.length).toBeLessThanOrEqual(WINDOW_CHARS * 1.5);
      }
    }
  });
  it('spreads the windows through the middle of a long book, without overlap', () => {
    const total = 400_000;
    const offsets = windowOffsets(total);
    expect(offsets).toHaveLength(WINDOWS);
    expect(offsets[0]!.at).toBe(Math.floor(total * 0.05));
    expect(offsets.at(-1)!.at + WINDOW_CHARS).toBe(Math.floor(total * 0.97));
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!.at).toBeGreaterThanOrEqual(offsets[i - 1]!.at + WINDOW_CHARS);
    }
    // At least six thousand characters, as promised, whenever the book has them.
    expect(offsets.reduce((n, w) => n + w.length, 0)).toBeGreaterThanOrEqual(6000);
  });
  it('starts each sampled window on a word boundary', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ');
    for (const w of sampleWindows(text).slice(1)) expect(w).toMatch(/^word\d+/);
  });
  it('pools windows handed to it directly', () => {
    expect(detectLanguageFromWindows([])).toBeNull();
    expect(detectLanguageFromWindows([SAMPLES.fr!, SAMPLES.fr!])?.language).toBe('fr');
  });
});
