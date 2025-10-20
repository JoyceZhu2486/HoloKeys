import sys, math
import numpy as np
import cv2
import mediapipe as mp

# ---- tweakable thresholds ----
# MIN_BLUR_VAR       = 50.0   # image sharpness (variance of Laplacian)
# MIN_HAND_AREA_FRAC = 0.015  # min bbox area fraction (~1.5% of image)
# MIN_HANDED_SCORE   = 0.30   # handedness confidence (0..1)
MIN_BLUR_VAR       = 40.0   # image sharpness (variance of Laplacian)
MIN_HAND_AREA_FRAC = 0.001  # min bbox area fraction (~1.5% of image)
MIN_HANDED_SCORE   = 0.05   # handedness confidence (0..1)
# ------------------------------

FINGERTIP_IDS = [4, 8, 12, 16, 20]  # thumb, index, middle, ring, pinky

def laplacian_var(gray):
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())

def bbox_from_landmarks(lms, W, H):
    xs = [lm.x * W for lm in lms]
    ys = [lm.y * H for lm in lms]
    x0, x1 = max(0, min(xs)), min(W, max(xs))
    y0, y1 = max(0, min(ys)), min(H, max(ys))
    return int(x0), int(y0), int(x1 - x0), int(y1 - y0)

def fingertip_pixels(lms, W, H):
    pts = {}
    for idx in FINGERTIP_IDS:
        lm = lms[idx]
        pts[idx] = (int(round(lm.x * W)), int(round(lm.y * H)))
    return pts

def main(img_path, out_path=None):
    img_bgr = cv2.imread(img_path)
    if img_bgr is None:
        print("Could not read image:", img_path)
        sys.exit(1)
    H, W = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    blur_var = laplacian_var(gray)

    mp_hands = mp.solutions.hands
    mp_draw  = mp.solutions.drawing_utils
    mp_style = mp.solutions.drawing_styles

    with mp_hands.Hands(
        static_image_mode=True,
        max_num_hands=2,
        min_detection_confidence=0.1
    ) as hands:
        rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        res = hands.process(rgb) 

    annotated = img_bgr.copy()
    hands_found = 0
    best_area_frac = 0.0
    per_hand = []

    if res.multi_hand_landmarks and res.multi_handedness:
        for lm, handed in zip(res.multi_hand_landmarks, res.multi_handedness):
            hands_found += 1
            side  = handed.classification[0].label  # 'Left' or 'Right'
            score = float(handed.classification[0].score)

            # Draw landmarks with side-specific color hint
            mp_draw.draw_landmarks(
                annotated, lm, mp_hands.HAND_CONNECTIONS,
                mp_style.get_default_hand_landmarks_style(),
                mp_style.get_default_hand_connections_style()
            )

            # Bbox & area fraction
            x, y, w, h = bbox_from_landmarks(lm.landmark, W, H)
            area_frac = (w * h) / (W * H + 1e-6)
            best_area_frac = max(best_area_frac, area_frac)

            # Fingertip pixel coordinates
            tips = fingertip_pixels(lm.landmark, W, H)

            # Draw bbox + labels
            color = (80, 200, 80) if side == "Left" else (80, 120, 240)
            cv2.rectangle(annotated, (x, y), (x + w, y + h), color, 2)
            cv2.putText(annotated, f"{side} {score:.2f}",
                        (x, max(0, y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

            # Mark fingertip dots
            for idx, (px, py) in tips.items():
                cv2.circle(annotated, (px, py), 4, color, -1)
                # label index fingertip only to reduce clutter
                if idx == 8:
                    cv2.putText(annotated, "idx", (px+4, py-4),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)

            per_hand.append({
                "side": side, "score": round(score, 3),
                "bbox_area_frac": round(area_frac, 4),
                "bbox_px": (w, h),
                "fingertips": tips
            })

    # Verdicts
    two_hands_ok = (hands_found >= 2)
    image_ok = (blur_var >= MIN_BLUR_VAR)
    size_ok  = (best_area_frac >= MIN_HAND_AREA_FRAC)
    useful   = two_hands_ok and image_ok and size_ok

    # Print summary
    print("=== Two-Hand Image Check ===")
    print(f"Image: {img_path} ({W}x{H})")
    print(f"Sharpness (varLap): {blur_var:.1f}  [min {MIN_BLUR_VAR}]")
    print(f"Hands found: {hands_found} (need 2)")
    if per_hand:
        for i, h in enumerate(per_hand, 1):
            print(f" Hand {i}: side={h['side']} score={h['score']} "
                  f"bbox_frac={h['bbox_area_frac']} bbox_px={h['bbox_px']}")
            # Show fingertip pixels compactly
            tips_str = ", ".join([f"{k}:{v}" for k, v in h['fingertips'].items()])
            print("  tips(px):", tips_str)
    print(f"Max hand area frac: {best_area_frac:.4f}  [min {MIN_HAND_AREA_FRAC}]")
    print("Verdict:", "USEFUL (two hands) ✅" if useful else "NOT USEFUL ❌")
    if not two_hands_ok:
        print("Hint: lower min_detection_confidence to 0.4, ensure both hands are visible & large enough, or try better lighting.")

    # Annotate footer
    status = "USEFUL" if useful else "NOT USEFUL"
    color  = (40,180,40) if useful else (40,40,220)
    cv2.putText(annotated, f"{status} | blur {blur_var:.0f} | hands {hands_found}/2",
                (10, H - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

    if out_path:
        cv2.imwrite(out_path, annotated)
        print("Saved:", out_path)


if __name__ == "__main__":
    # if len(sys.argv) < 2:
    #     print("Usage: python validate_hand_model.py input.jpg [out.jpg]")
    #     sys.exit(1)
    # img = sys.argv[1]
    # out = sys.argv[2] if len(sys.argv) > 2 else None
    for i in range(5){
        img = f"./testImage/testImage%d.jpg",i
        out = f"./testImage/testImage%dRes.jpg",i
        main(img, out)
    }
