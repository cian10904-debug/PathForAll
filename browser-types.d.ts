interface PathSpeechRecognition extends EventTarget {
  maxAlternatives: number; lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((event: {results: {transcript: string}[][]}) => void) | null;
  onerror: ((event: {error: string}) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
}
interface Window {
  SpeechRecognition?: new () => PathSpeechRecognition;
  webkitSpeechRecognition?: new () => PathSpeechRecognition;
}
