// ==========================================
// WEB NOVEL READER PRO — CONTENT SCRIPT
// ==========================================

const synth = window.speechSynthesis;

let isReading = false;
let currentRate = 1.0;
const MIN_RATE = 0.5;
const MAX_RATE = 3.0;

let paragraphsList = [];
let paragraphElements = [];
let currentIndex = 0;

let selectedVoiceName = null;
let keepAliveInterval = null;

let sleepTimeout = null;
let playbackTimer = null;
let sessionId = 0;
let chapterTransitionPending = false;


// ==========================================
// CHROME TTS FREEZE WORKAROUND
// ==========================================

function startKeepAlive() {
    stopKeepAlive();
    keepAliveInterval = setInterval(() => {
        if (synth.speaking && !synth.paused) {
            synth.pause();
            synth.resume();
        }
    }, 10000);
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}


// ==========================================
// VOICE SELECTION ENGINE
// ==========================================

function getAvailableVoices() {
    const voices = synth.getVoices();
    if (!voices.length) return [];

    // Prioritize high-quality voices (Google, Natural, Online, Microsoft)
    const englishVoices = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith("en"));

    return (englishVoices.length ? englishVoices : voices).map(v => ({
        name: v.name,
        lang: v.lang,
        localService: v.localService
    }));
}

function getChosenVoice() {
    const voices = synth.getVoices();
    if (!voices.length) return null;

    if (selectedVoiceName) {
        const found = voices.find(v => v.name === selectedVoiceName);
        if (found) return found;
    }

    const englishVoices = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith("en"));

    // Auto-select top quality voices if available
    return (
        englishVoices.find(v => v.name.includes("Google US English")) ||
        englishVoices.find(v => /natural|online|neural/i.test(v.name)) ||
        englishVoices[0] ||
        voices[0]
    );
}

if (synth.onvoiceschanged !== undefined) {
    synth.addEventListener("voiceschanged", () => {
        getAvailableVoices();
    });
}


// ==========================================
// TEXT CLEANING & SENTENCE SPLITTING
// Prevents high-speed slurring/blurting
// ==========================================

function cleanTextForSpeech(text) {
    return text
        .replace(/[\u2010-\u2015]/g, " ")
        .replace(/\.{2,}/g, ".")
        .replace(/[*_~`#@$%^&()={}[\]\\|<>]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function splitIntoSentences(text) {
    // Split text into distinct sentences so 2x-3x speed remains sharp
    return text.match(/[^.!?]+[.!?]+/g) || [text];
}


// ==========================================
// HIGHLIGHTING
// ==========================================

const style = document.createElement("style");
style.textContent = `
    .novel-reader-highlight {
        background-color: rgba(187, 134, 252, 0.25) !important;
        border-left: 4px solid #BB86FC !important;
        padding-left: 8px !important;
        transition: background-color 0.2s ease;
    }
`;
(document.head || document.documentElement).appendChild(style);

function clearHighlight() {
    paragraphElements.forEach(el => {
        el.classList.remove("novel-reader-highlight");
    });
}

function highlightParagraph(index) {
    clearHighlight();
    const element = paragraphElements[index];
    if (!element) return;

    element.classList.add("novel-reader-highlight");
    element.scrollIntoView({
        behavior: "smooth",
        block: "center"
    });
}


// ==========================================
// PARAGRAPH EXTRACTION
// ==========================================

function getCleanParagraphs() {
    const article =
        document.querySelector("article") ||
        document.querySelector("main") ||
        document.body;

    const elements = Array.from(article.querySelectorAll("p"))
        .filter(p => p.innerText.trim().length > 15);

    paragraphElements = elements;
    paragraphsList = elements
        .map(p => cleanTextForSpeech(p.innerText))
        .filter(text => text.length > 0);

    return paragraphsList.length;
}


// ==========================================
// PROGRESS SAVING
// ==========================================

function saveProgress() {
    const pageKey = window.location.href;
    chrome.storage.local.set({
        [pageKey]: currentIndex,
        savedRate: currentRate,
        savedVoice: selectedVoiceName
    });
}


// ==========================================
// NEXT CHAPTER DETECTION & AUTOPLAY
// ==========================================

function findNextChapterLink() {
    const semanticLink = document.querySelector('a[rel~="next"], link[rel~="next"]');
    if (semanticLink && semanticLink.tagName === "A" && semanticLink.href) return semanticLink;

    const selectors = ["a.next", "a.next-chapter", "a.chapter-next", ".next a", ".next-chapter a"];
    for (const selector of selectors) {
        const link = document.querySelector(selector);
        if (link && link.href) return link;
    }

    const links = Array.from(document.querySelectorAll("a[href]"));
    return links.find(l => /next|next chapter/i.test(l.innerText.trim())) || null;
}

function triggerNextChapter() {
    const nextLink = findNextChapterLink();
    if (nextLink && nextLink.href && nextLink.href !== window.location.href) {
        window.location.assign(nextLink.href);
        return true;
    }
    return false;
}

function startNextChapterIfNeeded() {
    if (!chapterTransitionPending) return;
    chapterTransitionPending = false;

    chrome.storage.local.get(["autoPlayNext", "savedRate", "savedVoice"], result => {
        if (!result.autoPlayNext) return;

        currentRate = Number(result.savedRate) || 1.0;
        selectedVoiceName = result.savedVoice || null;

        chrome.storage.local.set({ autoPlayNext: false });

        setTimeout(() => {
            if (!isReading) startReading(currentRate);
        }, 1200);
    });
}

window.addEventListener("load", startNextChapterIfNeeded);


// ==========================================
// PLAYBACK ENGINE WITH SENTENCE QUEUING
// ==========================================

function clearPlaybackTimer() {
    if (playbackTimer !== null) {
        clearTimeout(playbackTimer);
        playbackTimer = null;
    }
}

function speakParagraphs(index, activeSession = sessionId) {
    if (!isReading || activeSession !== sessionId) return;

    clearPlaybackTimer();

    if (index < 0) index = 0;

    if (index >= paragraphsList.length) {
        clearHighlight();
        chrome.storage.local.set({
            autoPlayNext: true,
            savedRate: currentRate,
            savedVoice: selectedVoiceName
        }, () => {
            if (!isReading || activeSession !== sessionId) return;
            stopReading();
            triggerNextChapter();
        });
        return;
    }

    currentIndex = index;
    highlightParagraph(currentIndex);
    saveProgress();

    const rawParagraph = paragraphsList[currentIndex];
    if (!rawParagraph) {
        speakParagraphs(currentIndex + 1, activeSession);
        return;
    }

    synth.cancel();

    // Chunk text into sentences to preserve crisp articulation at 2x-3x speeds
    const sentences = splitIntoSentences(rawParagraph);
    let sentenceIndex = 0;

    function speakNextSentence() {
        if (!isReading || activeSession !== sessionId) return;

        if (sentenceIndex >= sentences.length) {
            currentIndex++;
            playbackTimer = setTimeout(() => {
                speakParagraphs(currentIndex, activeSession);
            }, 80);
            return;
        }

        const utterance = new SpeechSynthesisUtterance(sentences[sentenceIndex]);
        const voice = getChosenVoice();

        if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
        }

        utterance.rate = Math.min(Math.max(currentRate, MIN_RATE), MAX_RATE);
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        utterance.onend = () => {
            sentenceIndex++;
            speakNextSentence();
        };

        utterance.onerror = (e) => {
            if (e.error === "interrupted" || e.error === "canceled") return;
            sentenceIndex++;
            speakNextSentence();
        };

        synth.speak(utterance);
    }

    startKeepAlive();
    speakNextSentence();
}


// ==========================================
// START / STOP / CONTROLS
// ==========================================

function startReading(initialRate) {
    sessionId++;
    const thisSession = sessionId;

    clearPlaybackTimer();
    isReading = true;

    currentRate = Math.min(Math.max(Number(initialRate) || currentRate || 1.0, MIN_RATE), MAX_RATE);

    chrome.storage.local.set({ savedRate: currentRate, autoPlayNext: false });

    getCleanParagraphs();

    const pageKey = window.location.href;
    chrome.storage.local.get([pageKey, "savedVoice"], data => {
        if (!isReading || thisSession !== sessionId) return;
        if (data.savedVoice) selectedVoiceName = data.savedVoice;

        const savedIndex = Number(data[pageKey]) || 0;
        speakParagraphs(savedIndex, thisSession);
    });
}

function stopReading() {
    sessionId++;
    isReading = false;
    clearPlaybackTimer();
    stopKeepAlive();
    synth.cancel();
    clearHighlight();

    if (sleepTimeout !== null) {
        clearTimeout(sleepTimeout);
        sleepTimeout = null;
    }

    chrome.storage.local.set({ autoPlayNext: false });
}

function setSpeed(newRate) {
    const rate = Number(newRate);
    if (!Number.isFinite(rate)) return;

    currentRate = Math.min(Math.max(rate, MIN_RATE), MAX_RATE);
    chrome.storage.local.set({ savedRate: currentRate });

    if (isReading) {
        sessionId++;
        speakParagraphs(currentIndex, sessionId);
    }
}

function setVoice(voiceName) {
    selectedVoiceName = voiceName;
    chrome.storage.local.set({ savedVoice: voiceName });

    if (isReading) {
        sessionId++;
        speakParagraphs(currentIndex, sessionId);
    }
}


// ==========================================
// MESSAGE HANDLER
// ==========================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case "GET_STATE":
            sendResponse({
                isReading,
                currentRate,
                voices: getAvailableVoices(),
                selectedVoice: selectedVoiceName || (getChosenVoice() ? getChosenVoice().name : "")
            });
            break;

        case "START":
            stopReading();
            if (request.voiceName) selectedVoiceName = request.voiceName;
            if (request.timerMinutes > 0) setSleepTimer(request.timerMinutes);
            startReading(request.initialRate);
            sendResponse({ success: true });
            break;

        case "STOP":
            stopReading();
            sendResponse({ success: true });
            break;

        case "CHANGE_SPEED":
            setSpeed(request.newRate);
            sendResponse({ success: true, currentRate });
            break;

        case "CHANGE_VOICE":
            setVoice(request.voiceName);
            sendResponse({ success: true });
            break;

        case "SKIP_BACK":
            if (isReading) {
                sessionId++;
                speakParagraphs(Math.max(0, currentIndex - 1), sessionId);
            }
            sendResponse({ success: true });
            break;

        case "SKIP_FORWARD":
            if (isReading) {
                sessionId++;
                speakParagraphs(Math.min(paragraphsList.length - 1, currentIndex + 1), sessionId);
            }
            sendResponse({ success: true });
            break;

        default:
            return false;
    }
    return true;
});