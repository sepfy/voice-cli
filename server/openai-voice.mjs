const openaiUrl = "https://api.openai.com/v1";

export function createOpenAiVoice(config) {
  function headers() {
    if (!config.openaiApiKey) throw new Error("Set OPENAI_API_KEY to enable voice.");
    return { Authorization: `Bearer ${config.openaiApiKey}` };
  }

  return {
    configured: () => Boolean(config.openaiApiKey),
    async transcribe(audio, mimeType) {
      const form = new FormData();
      form.set("model", config.openaiSttModel);
      form.set("file", new Blob([audio], { type: mimeType || "audio/webm" }), "recording.webm");
      const response = await fetch(`${openaiUrl}/audio/transcriptions`, { method: "POST", headers: headers(), body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || "OpenAI transcription failed.");
      return data.text?.trim() || "";
    },
    async speak(text) {
      const response = await fetch(`${openaiUrl}/audio/speech`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.openaiTtsModel, voice: config.openaiTtsVoice, input: text, response_format: "mp3" })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error?.message || "OpenAI speech synthesis failed.");
      }
      return Buffer.from(await response.arrayBuffer());
    }
  };
}
