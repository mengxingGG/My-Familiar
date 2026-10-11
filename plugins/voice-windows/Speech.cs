using System;
using System.IO;
using System.Linq;
using System.Globalization;
using System.Security;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Threading;

// Windows 自带识别器只做本地唤醒；对话录音由语音插件按用户配置处理。
class FamiliarSpeech {
  static JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
  static void Emit(object value) { lock(json) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
  static string Get(Dictionary<string, object> v, string key, string fallback) { return v.ContainsKey(key) ? Convert.ToString(v[key]) : fallback; }
  static int Main(string[] args) {
    Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    Console.InputEncoding = new System.Text.UTF8Encoding(false);
    try {
      if (args.Contains("--probe")) {
        using (var synth = new SpeechSynthesizer()) Emit(new {
          voices = synth.GetInstalledVoices().Where(v => v.Enabled).Select(v => new { id = v.VoiceInfo.Name, name = v.VoiceInfo.Name, culture = v.VoiceInfo.Culture.Name }).ToArray(),
          recognizers = SpeechRecognitionEngine.InstalledRecognizers().Select(v => new { id = v.Id, culture = v.Culture.Name }).ToArray()
        });
        return 0;
      }
      var request = json.Deserialize<Dictionary<string, object>>(Console.ReadLine());
      if (args.Contains("--speak")) {
        using (var synth = new SpeechSynthesizer()) using (var memory = new MemoryStream()) {
          var selected = Get(request, "voice", "");
          var voices = synth.GetInstalledVoices().Where(v => v.Enabled).Select(v => v.VoiceInfo).ToArray();
          if (selected.Length == 0) selected = voices.FirstOrDefault(v => v.Name.Contains("Yaoyao")) != null ? voices.First(v => v.Name.Contains("Yaoyao")).Name : voices.First(v => v.Culture.Name.StartsWith("zh")).Name;
          synth.SelectVoice(selected);
          var style = Get(request, "style", "gentle");
          var rate = style == "enthusiastic" || style == "concise" ? 1 : style == "gentle" ? -1 : 0;
          double speed = 1; double.TryParse(Get(request, "speed", "1"), NumberStyles.Float, CultureInfo.InvariantCulture, out speed);
          synth.Rate = Math.Max(-5, Math.Min(5, rate + (int)Math.Round((speed - 1) * 5)));
          var pitch = style == "enthusiastic" ? "+18%" : style == "direct" ? "+3%" : "+10%";
          synth.SetOutputToWaveStream(memory);
          var text = SecurityElement.Escape(Get(request, "text", "在呢。"));
          synth.SpeakSsml("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + synth.Voice.Culture.Name + "'><prosody pitch='" + pitch + "'>" + text + "</prosody></speak>");
          Emit(new { data = Convert.ToBase64String(memory.ToArray()), voice = selected });
        }
        return 0;
      }
      var recognizers = SpeechRecognitionEngine.InstalledRecognizers();
      var info = recognizers.FirstOrDefault(v => v.Culture.Name.StartsWith("zh"));
      if (info == null) throw new Exception("Windows 未安装中文语音识别器，可手动开始语音，或安装中文语音识别语言包后使用唤醒。");
      using (var engine = new SpeechRecognitionEngine(info)) {
        var phrases = ((System.Collections.IEnumerable)request["phrases"]).Cast<object>().Select(v => v.ToString()).ToArray();
        // 名字是必需关键词，前后可以说别的话；不是把“起床了”写死为指令。
        // 前后用通配（垃圾模型）而非自由听写：真实麦克风下听写会吞掉整句，名字置信度跌到 0.3 以下被拒。
        var builder = new GrammarBuilder { Culture = info.Culture };
        builder.AppendWildcard(); builder.Append(new SemanticResultKey("wake", new Choices(phrases))); builder.AppendWildcard();
        engine.LoadGrammar(new Grammar(builder) { Name = "name-in-speech" });
        // 单独喊名字时不必等待自由听写部分完成，仍保留任意前后缀的语法。
        var nameOnly = new GrammarBuilder { Culture = info.Culture };
        nameOnly.Append(new SemanticResultKey("wake", new Choices(phrases)));
        engine.LoadGrammar(new Grammar(nameOnly) { Name = "name-only", Priority = 1 });
        engine.EndSilenceTimeout = TimeSpan.FromMilliseconds(250);
        engine.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(450);
        if (args.Contains("--grammar-check")) { Emit(new { valid = true, keywords = phrases }); return 0; }
        if (request.ContainsKey("wave")) engine.SetInputToWaveFile(Get(request, "wave", ""));
        else engine.SetInputToDefaultAudioDevice();
        var threshold = request.ContainsKey("threshold") ? Convert.ToDouble(request["threshold"]) : 0.6;
        var lastWake = DateTime.MinValue;
        var lastLevel = DateTime.MinValue;
        engine.AudioLevelUpdated += (s, e) => { if ((DateTime.UtcNow - lastLevel).TotalMilliseconds >= 200) { lastLevel = DateTime.UtcNow; Emit(new { level = e.AudioLevel }); } };
        engine.AudioSignalProblemOccurred += (s, e) => Emit(new { signal = e.AudioSignalProblem.ToString() });
        engine.SpeechDetected += (s, e) => Emit(new { speech = true });
        engine.SpeechRecognitionRejected += (s, e) => Emit(new { rejected = true, confidence = e.Result == null ? 0 : e.Result.Confidence });
        engine.SpeechRecognized += (s, e) => {
          // 使用名字自身的声学置信度；长句中自由听写的低分不应拖累唤醒词。
          var nameConfidence = e.Result.Semantics.ContainsKey("wake") ? e.Result.Semantics["wake"].Confidence : 0;
          var accepted = nameConfidence >= threshold;
          Emit(new { recognized = true, accepted, confidence = nameConfidence });
          if (accepted && (DateTime.UtcNow - lastWake).TotalSeconds > 2) {
            lastWake = DateTime.UtcNow;
            // 通配文本不是原话；仅在内存交接已识别片段，单喊名字不额外发起模型问答。
            string audio = null;
            if (e.Result.Grammar.Name != "name-only" && e.Result.Audio != null && e.Result.Audio.Duration.TotalSeconds <= 8) {
              using (var memory = new MemoryStream()) {
                e.Result.Audio.WriteToWaveStream(memory);
                audio = Convert.ToBase64String(memory.ToArray());
              }
            }
            Emit(new { wake = Convert.ToString(e.Result.Semantics["wake"].Value), audio });
          }
        };
        if (request.ContainsKey("wave")) { var result = engine.Recognize(); Emit(new { recognized = result == null ? "" : result.Text, confidence = result == null ? 0 : result.Confidence }); return 0; }
        engine.RecognizeAsync(RecognizeMode.Multiple); Emit(new { ready = true });
        Console.ReadLine(); engine.RecognizeAsyncCancel();
      }
      return 0;
    } catch (Exception e) { Emit(new { error = e.Message }); return 1; }
  }
}
