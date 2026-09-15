/**
 * Strings of the pairs surface: the Pairing page, its cards, the manual-link
 * sheet and every toast it raises. Keys are `pairs.*`.
 */
export const pairs = {
  // Page head
  'pairs.lede':
    'Ebook and audiobook editions of the same work. Metadata alone never links anything: strong matches are verified against the narration first, uncertain ones wait for you.',
  'pairs.howItWorks': 'How it works',
  'pairs.howItWorksLabel': 'How alignment works',
  'pairs.linkManually': 'Link manually',
  'pairs.loadFailed': 'Could not load pairing data.',
  // Alignment work summary (admins, when verified books wait to be aligned)
  'pairs.work.label': 'Alignment work',
  'pairs.work.ready':
    '{n, plural, one {# verified book is ready to align} other {# verified books are ready to align}}',
  'pairs.work.estimate':
    '{computing} of computing for {audio} of audio, measured from this server’s own speed. They run one at a time and you can stop any of them.',
  'pairs.work.noEstimate':
    '{audio} of audio in total. The first run will measure how fast this server aligns, and the estimate appears here.',
  'pairs.work.clearSelection': 'Clear {n}',
  'pairs.work.startSelected': 'Start {n} selected',
  'pairs.work.startAll': 'Start all {n}',
  'pairs.work.autoAlign': 'Align every new match',
  'pairs.work.autoAlignOn': 'New matches queue themselves. Turn off to start books yourself.',
  'pairs.work.autoAlignOff': 'Nothing runs on its own - start books from here.',
  'pairs.work.precisionLabel': 'How closely alignment listens',
  'pairs.work.precisionTitle': 'How closely alignment listens to the narration',
  'pairs.work.precision.standard': 'Standard',
  'pairs.work.precision.standardBlurb': 'Minutes per book · lands on the paragraph',
  'pairs.work.precision.exact': 'Sentence-perfect',
  'pairs.work.precision.exactBlurb': 'Hours per book · lands on the sentence',
  // Empty state and the three sections
  'pairs.emptyTitle': 'No pair suggestions yet',
  'pairs.emptyBody':
    'Pair candidates appear after a library scan finds ebook and audiobook editions with matching metadata. Nothing is ever linked without strong evidence.',
  'pairs.section.needsReview': 'Needs review',
  'pairs.section.linkAll': 'Link all {n}',
  'pairs.section.linking': 'Linking…',
  'pairs.section.linked': 'Linked',
  'pairs.section.linkedLabel': 'Linked pairs',
  'pairs.section.dismissed': 'Dismissed',
  'pairs.section.dismissedLabel': 'Dismissed pairs',
  // Pair card
  'pairs.card.select': 'Select',
  'pairs.card.selectForAlignment': 'Select {title} for alignment',
  'pairs.card.thisPair': 'this pair',
  'pairs.card.status':
    '{status, select, auto {Linked automatically} confirmed {Confirmed by you} candidate {Suggested} other {Dismissed}}',
  'pairs.card.switchReady': 'Switch ready · {pct} exact',
  'pairs.card.timeToAlign': '≈ {span} to align',
  'pairs.card.match': 'Match {pct}',
  'pairs.card.verifiedNote':
    'Strong metadata match - content verification passed; linked automatically.',
  'pairs.card.unalignedNote':
    'Not aligned yet - switching between editions is unavailable until alignment completes.',
  // Narration language picker
  'pairs.language.label': 'Narration',
  'pairs.language.sourceTitle':
    'Language {source, select, override {set by you} alignment {detected} ebook-metadata {from the ebook} audio-tags {from the audio tags} other {unknown - will be detected}}',
  'pairs.language.auto': 'Auto',
  'pairs.language.autoWith': 'Auto · {name}',
  'pairs.language.autoDetect': 'Auto · detect',
  'pairs.language.option': '{name} · {native}',
  // Evidence grid
  'pairs.evidence.title': 'Title',
  'pairs.evidence.author': 'Author',
  'pairs.evidence.identifiers': 'Identifiers',
  'pairs.evidence.language': 'Language',
  'pairs.evidence.lengthRatio': 'Length ratio',
  'pairs.evidence.ratio': '{ratio}×',
  'pairs.evidence.contentOverlap': 'Content overlap',
  'pairs.evidence.match': 'Match',
  'pairs.evidence.mismatch': 'Mismatch',
  'pairs.evidence.good': '- good',
  'pairs.evidence.poor': '- poor',
  // Alignment job state
  'pairs.job.queued': 'Alignment queued',
  'pairs.job.aligning': 'Aligning',
  'pairs.job.modelNeeded': 'Alignment model needed.',
  'pairs.job.modelDownloadHint': 'Download it and this alignment runs by itself when it lands.',
  'pairs.job.download': 'Download',
  'pairs.job.models': 'Models',
  'pairs.job.failed': 'Alignment failed. Try again, or check the server log.',
  // Alignment summary and coverage strip
  'pairs.aligned.title': 'Aligned',
  'pairs.aligned.sentenceExact': '{pct} sentence-exact',
  'pairs.aligned.coverage': 'coverage {pct}',
  'pairs.aligned.confidence': 'confidence {pct}',
  'pairs.aligned.sentences': '{n, plural, one {# sentence} other {# sentences}}',
  'pairs.aligned.gaps': '{n, plural, one {# gap} other {# gaps}} (e.g. {reason} {from}–{to})',
  'pairs.coverage.label':
    'Alignment confidence per minute across {n, plural, one {# minute} other {# minutes}}, average {pct}',
  'pairs.coverage.minute': 'Minute {minute}: {pct}',
  'pairs.coverage.minutes': 'Minutes {from}–{to}: {pct}',
  // Pair actions
  'pairs.actions.linkEditions': 'Link editions',
  'pairs.actions.notAMatch': 'Not a match',
  'pairs.actions.runAlignment': 'Run alignment',
  'pairs.actions.rerunAlignment': 'Re-run alignment',
  'pairs.actions.unlink': 'Unlink',
  'pairs.actions.linkAnyway': 'Link anyway',
  // Manual link sheet
  'pairs.manual.title': 'Link two books manually',
  'pairs.manual.note':
    'Choose an ebook and an audiobook of the same work. Alignment runs after linking; switching between editions is unavailable until alignment completes.',
  'pairs.manual.chooseEbook': 'Choose an ebook…',
  'pairs.manual.chooseAudiobook': 'Choose an audiobook…',
  'pairs.manual.libraryFailed': 'Could not load the library.',
  'pairs.manual.linkFailed': 'Linking failed.',
  // Toasts
  'pairs.toast.acted':
    '{action, select, confirm {Pair confirmed - alignment queued} align {Alignment queued} reject {Suggestion dismissed} other {Pair unlinked}}',
  'pairs.toast.actionFailed': 'Action failed',
  'pairs.toast.linkedMany': 'Linked {n, plural, one {# book} other {# books}} - alignment queued',
  'pairs.toast.nothingToLink': 'Nothing left to link',
  'pairs.toast.couldNotLink': 'Could not link those pairs.',
  'pairs.toast.queuedMany': 'Queued {n, plural, one {# book} other {# books}} for alignment',
  'pairs.toast.nothingToQueue': 'Nothing new to queue',
  'pairs.toast.couldNotQueue': 'Could not queue those pairs',
  'pairs.toast.languageSet': 'Narration language set to {name}',
  'pairs.toast.languageReset': 'Language reset',
  'pairs.toast.couldNotChangeLanguage': 'Could not change the language.',
  'pairs.toast.modelDownloading':
    'Downloading the alignment model - alignment resumes when it lands',
  'pairs.toast.watchProgress': 'Watch progress',
  'pairs.toast.couldNotDownload': 'Could not start the download.',
  'pairs.toast.couldNotSave': 'Could not save that.',
  'pairs.toast.manualLinked': 'Pair linked - alignment queued',
} as const;
