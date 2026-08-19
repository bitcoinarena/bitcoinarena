using UnityEngine;

/// <summary>
/// On-screen readout. With a camera that follows the truck over untextured
/// ground there is nothing in frame to move against, so "is it driving?" is
/// genuinely unanswerable by eye - these numbers answer it.
/// </summary>
public class DriveHud : MonoBehaviour
{
    public TruckController truck;
    public MarketFeed market;
    public Battlefield field;
    Rigidbody _rb;
    GUIStyle _style;

    void Start() { if (truck != null) _rb = truck.GetComponent<Rigidbody>(); }

    void OnGUI()
    {
        if (truck == null || _rb == null) return;
        if (_style == null)
            _style = new GUIStyle(GUI.skin.label) { fontSize = 18, normal = { textColor = Color.white } };

        int grounded = 0;
        foreach (var a in truck.axles)
        {
            if (a?.left != null && a.left.isGrounded) grounded++;
            if (a?.right != null && a.right.isGrounded) grounded++;
        }

        GUI.Box(new Rect(10, 10, 330, 170), GUIContent.none);
        GUI.Label(new Rect(22, 18, 320, 26), $"Tempo    {truck.SpeedKmh:0} km/h", _style);
        GUI.Label(new Rect(22, 44, 320, 26), $"Gas      {DriveInput.Throttle:+0.0;-0.0; 0.0}    Lenkung {DriveInput.Steer:+0.0;-0.0; 0.0}", _style);
        GUI.Label(new Rect(22, 70, 320, 26), $"Handbr.  {(DriveInput.Handbrake ? "AN" : "aus")}", _style);
        GUI.Label(new Rect(22, 96, 320, 26), $"Drift    {truck.Slip:0.00} m/s seitlich", _style);
        GUI.Label(new Rect(22, 122, 320, 26), $"Raeder   {grounded}/4 am Boden", _style);
        GUI.Label(new Rect(22, 148, 320, 26), $"Position {_rb.position.x:0}, {_rb.position.z:0}", _style);

        if (market != null)
        {
            GUI.Box(new Rect(10, 190, 330, 96), GUIContent.none);
            GUI.Label(new Rect(22, 198, 320, 26),
                $"BTC      {(market.Price > 0 ? market.Price.ToString("N0") : "-")} USD  ({market.Status})", _style);
            GUI.Label(new Rect(22, 224, 320, 26),
                $"24h      {market.DayChangePct:+0.00;-0.00;0.00} %   Fluss {market.Flow:+0.00;-0.00; 0.00}", _style);
            GUI.Label(new Rect(22, 250, 320, 26),
                $"Liquid.  {market.Liquidations.Count} in 90 s", _style);
        }
        if (field != null && truck != null)
        {
            float front = field.FrontlineZ(truck.transform.position.x);
            bool bull = field.IsBullHeld(truck.transform.position.x, truck.transform.position.z);
            GUI.Label(new Rect(22, 292, 420, 26),
                $"Front    z={front:0}   du stehst im {(bull ? "BULLEN" : "BAeREN")}-Gebiet", _style);
        }

        if (DriveInput.Throttle == 0f && DriveInput.Steer == 0f)
            GUI.Label(new Rect(22, 322, 520, 26),
                "Keine Eingabe - ins Bild klicken, dann W/A/S/D oder Pfeiltasten  (R = zurücksetzen)", _style);
    }
}
