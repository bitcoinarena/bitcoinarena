using UnityEngine;

/// <summary>
/// On-screen readout. With a camera that follows the truck over untextured
/// ground there is nothing in frame to move against, so "is it driving?" is
/// genuinely unanswerable by eye - these numbers answer it.
/// </summary>
public class DriveHud : MonoBehaviour
{
    public TruckController truck;
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

        if (DriveInput.Throttle == 0f && DriveInput.Steer == 0f)
            GUI.Label(new Rect(22, 190, 460, 26),
                "Keine Eingabe - ins Bild klicken, dann W/A/S/D oder Pfeiltasten  (R = zurücksetzen)", _style);
    }
}
