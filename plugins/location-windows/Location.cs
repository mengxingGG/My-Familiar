using System;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Windows.Devices.Geolocation;

// 独立 STA 窗口承载系统授权，避免在后台线程触发定位提示。
class FamiliarLocation : Form {
    readonly bool prompt;
    readonly Label label = new Label();
    bool finished;
    FamiliarLocation(bool ask) {
        prompt = ask;
        Text = "Familiar · 位置授权";
        Width = 430; Height = 150; StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
        label.Text = "仅为主动关怀获取设备位置。不会通过 IP 猜测位置。";
        label.Dock = DockStyle.Fill; label.Padding = new Padding(20); Controls.Add(label);
        if (!prompt) { ShowInTaskbar = false; Opacity = 0; }
        Shown += async (sender, args) => {
            try {
                if (prompt) {
                    Activate();
                    var access = await System.WindowsRuntimeSystemExtensions.AsTask(Geolocator.RequestAccessAsync());
                    if (access != GeolocationAccessStatus.Allowed) throw new Exception("Windows 未授权位置，请检查系统位置设置。");
                    label.Text = "正在读取设备位置…";
                }
                var locator = new Geolocator { DesiredAccuracyInMeters = 100 };
                var position = await System.WindowsRuntimeSystemExtensions.AsTask(locator.GetGeopositionAsync(TimeSpan.FromMinutes(2), TimeSpan.FromSeconds(25)));
                var c = position.Coordinate;
                Finish(new { latitude = c.Point.Position.Latitude, longitude = c.Point.Position.Longitude, accuracy = c.Accuracy, source = c.PositionSource.ToString(), time = c.Timestamp.ToUnixTimeMilliseconds() });
            } catch { Finish(new { error = "设备位置不可用或未获 Windows 授权；将使用普通问候。" }); }
        };
        FormClosing += (sender, args) => { if (!finished) Finish(new { error = "位置读取已取消" }); };
    }
    void Finish(object value) {
        if (finished) return; finished = true;
        Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Close();
    }
    [STAThread] static void Main(string[] args) {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        if (Array.IndexOf(args, "--self-test") >= 0) { Console.WriteLine(new JavaScriptSerializer().Serialize(new { available = typeof(Geolocator).FullName })); return; }
        Application.EnableVisualStyles();
        Application.Run(new FamiliarLocation(Array.IndexOf(args, "--prompt") >= 0));
    }
}
