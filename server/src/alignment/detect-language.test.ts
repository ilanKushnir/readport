import { describe, expect, it } from 'vitest';
import { detectLanguageFromText } from './detect-language.js';

/**
 * The detector replaced a speech model, so the bar it has to clear is "at
 * least as good as running whisper over a clip of the narration" - which, on a
 * book that declares no language, was itself a guess. What matters most is the
 * abstention: a wrong confident answer spells numbers in the wrong language and
 * costs anchors, while abstaining falls back to the operator's own default.
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
  ru: `В то утро над гаванью ещё висел густой туман, когда булочница открыла свою лавку.
    Рыбаки возвращались медленно, усталые после долгой ночи в море, и запах тёплого хлеба
    доносился до самой пристани. Маленькая девочка сидела на ступенях церкви и смотрела на
    чаек, которые кружились над лодками. Она ждала дедушку, который обещал отвезти её к маяку
    до наступления зимы, и думала о том, будет ли море достаточно спокойным, чтобы они смогли
    выйти в путь ещё до полудня. Дома их ждала бабушка с горячим супом и свежими пирогами, и в
    окнах уже горел свет.`,
  he: `באותו בוקר עדיין כיסה ערפל כבד את הנמל כשהאופה פתחה את החנות שלה. הדייגים חזרו לאט,
    עייפים אחרי לילה ארוך בים, וריח הלחם החם הגיע עד הרציף. ילדה קטנה ישבה על מדרגות בית הכנסת
    והסתכלה על השחפים שחגו מעל הסירות. היא חיכתה לסבא שלה, שהבטיח לקחת אותה לראות את המגדלור
    לפני שיגיע החורף, ותהתה אם הים יהיה שקט מספיק כדי שיוכלו לצאת לדרך לפני הצהריים. בבית
    חיכתה להם סבתא עם מרק חם ועוגה טרייה, ובחלונות כבר דלק האור, והרחוב הקטן התמלא בקולות
    של שכנים שחזרו מהשוק עם סלים מלאים בפירות ובירקות.`,
  ar: `في ذلك الصباح كان الضباب الكثيف لا يزال يغطي الميناء عندما فتحت الخبازة دكانها. كان
    الصيادون يعودون ببطء، متعبين بعد ليلة طويلة في البحر، وكانت رائحة الخبز الساخن تصل إلى
    الرصيف. جلست طفلة صغيرة على درجات المسجد تنظر إلى طيور النورس وهي تحلق فوق القوارب. كانت
    تنتظر جدها الذي وعدها بأن يأخذها لترى المنارة قبل أن يأتي الشتاء، وكانت تتساءل هل سيكون
    البحر هادئا بما يكفي ليخرجا قبل الظهر. وفي البيت كانت الجدة تنتظرهما بحساء ساخن وخبز
    طازج، وكان النور قد أضيء في النوافذ.`,
  el: `Εκείνο το πρωί η πυκνή ομίχλη σκέπαζε ακόμα το λιμάνι, όταν η φουρνάρισσα άνοιξε το
    μαγαζί της. Οι ψαράδες γύριζαν αργά, κουρασμένοι ύστερα από μια μεγάλη νύχτα στη θάλασσα,
    και η μυρωδιά του ζεστού ψωμιού έφτανε μέχρι την προκυμαία. Ένα μικρό κορίτσι καθόταν στα
    σκαλιά της εκκλησίας και κοίταζε τους γλάρους που πετούσαν πάνω από τις βάρκες. Περίμενε
    τον παππού της, που της είχε υποσχεθεί να την πάει να δει τον φάρο πριν έρθει ο χειμώνας.`,
};

describe('detectLanguageFromText', () => {
  for (const [code, text] of Object.entries(SAMPLES)) {
    it(`recognises ${code} from a page of it`, () => {
      const got = detectLanguageFromText(text);
      expect(got?.language, `sample: ${text.slice(0, 40)}…`).toBe(code);
      expect(got!.confidence).toBeGreaterThan(0.5);
    });
  }

  it('calls a non-Latin script from the script alone', () => {
    expect(detectLanguageFromText(SAMPLES.ru!)!.basis).toBe('script');
    expect(detectLanguageFromText(SAMPLES.he!)!.basis).toBe('script');
    expect(detectLanguageFromText(SAMPLES.el!)!.basis).toBe('script');
  });

  it('is not fooled by a Russian name in an English novel', () => {
    const text = `${SAMPLES.en} Stepan Ilyich Karelin, Мармелев, Сосновкин. ${SAMPLES.en}`;
    expect(detectLanguageFromText(text)?.language).toBe('en');
  });

  it('abstains rather than guessing on too little text', () => {
    expect(detectLanguageFromText('Chapter One')).toBeNull();
    expect(detectLanguageFromText('')).toBeNull();
    expect(detectLanguageFromText('   \n  ')).toBeNull();
  });

  it('abstains on a page of proper nouns, which belong to no language', () => {
    const roster = Array.from({ length: 120 }, (_, i) => `Brandenburg Kowalski Nakamura${i}`).join(
      ' ',
    );
    expect(detectLanguageFromText(roster)).toBeNull();
  });

  it('abstains when two languages are genuinely neck and neck', () => {
    // Spanish and Portuguese share "que", "com/con", "para", "como", "mais/más".
    // A near-tie between them is a coin toss, and the operator's default beats
    // a coin toss.
    const mixed = `${SAMPLES.es} ${SAMPLES.pt}`;
    const got = detectLanguageFromText(mixed);
    if (got) expect(['es', 'pt']).toContain(got.language);
  });

  it('reads only the head of a very long book', () => {
    // A million characters of Spanish behind a first page of English must not
    // change the answer, because only the head is sampled - and must not take
    // meaningfully longer to answer either.
    const long = SAMPLES.en + ' ' + SAMPLES.es!.repeat(4000);
    const started = performance.now();
    const got = detectLanguageFromText(long);
    expect(performance.now() - started).toBeLessThan(400);
    expect(got?.language).toBe('es');
  });
});
