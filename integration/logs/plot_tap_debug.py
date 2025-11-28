import argparse
import json

import pandas as pd
import matplotlib.pyplot as plt


'''

python plot_tap_debug.py \
  --motion fingertip_motion_2025-11-28T14-15-02-255Z \
  --candidates tap_candidates_2025-11-28T14-15-02-255Z.json \
  --states tap_fsm_states_2025-11-28T14-15-02-255Z.json \
  --hand 0 \
  --finger 8

'''

PHASE_COLORS = {
    "idle": "gray",
    "lift": "blue",
    "tapDescent": "orange",
    "tapDwell": "red",
    None: "black",
}


def load_motion(motion_path, hand_index):
    """
    Load fingertip motion CSV.

    Our CSV is already index-finger-only, with columns:
    t, handIndex, x_raw, y_raw, x_refined, y_refined, tapScore, tapSpeed, tapDist, tapLabel
    So we only filter by handIndex here.
    """
    df = pd.read_csv(motion_path)
    if "handIndex" not in df.columns:
        raise ValueError(f"'handIndex' column not found in {motion_path}")

    df = df[df["handIndex"] == hand_index].copy()
    if df.empty:
        raise ValueError(
            f"No rows for handIndex={hand_index} in {motion_path}"
        )

    t0 = df["t"].min()
    df["t_rel_ms"] = df["t"] - t0
    df["t_s"] = df["t_rel_ms"] / 1000.0
    return df, t0



def load_tap_candidates(cand_path, t0, hand_index, finger_index):
    with open(cand_path, "r") as f:
        candidates = json.load(f)

    idx_taps = [
        tap for tap in candidates
        if tap.get("handIndex") == hand_index and tap.get("fingerIndex") == finger_index
    ]

    # Convert timestamps to relative seconds
    for tap in idx_taps:
        tap["t_rel_ms"] = tap["timestamp"] - t0
        tap["t_s"] = tap["t_rel_ms"] / 1000.0

    return idx_taps


def load_phase_states(state_path, t0, hand_index, finger_index):
    with open(state_path, "r") as f:
        events = json.load(f)

    df_states = pd.DataFrame(events)
    if df_states.empty:
        raise ValueError("No FSM state events in {}".format(state_path))

    df_states = df_states[
        (df_states["handIndex"] == hand_index)
        & (df_states["fingerIndex"] == finger_index)
    ].copy()
    if df_states.empty:
        raise ValueError("No FSM state events for handIndex={} fingerIndex={}".format(
            hand_index, finger_index
        ))

    df_states["t_rel_ms"] = df_states["timestamp"] - t0
    df_states["t_s"] = df_states["t_rel_ms"] / 1000.0
    df_states = df_states.sort_values("t_s").reset_index(drop=True)
    return df_states


def assign_phase_to_samples(df_motion, df_states):
    """
    For each row in df_motion, assign the FSM phase by taking the most recent
    stateChange event at or before that time (backward fill).
    """
    # We care about toPhase as the "current phase"
    df_states_small = df_states[["t_s", "toPhase"]].rename(columns={"t_s": "t_state"})
    # merge_asof to align state changes to motion samples
    df_motion_sorted = df_motion.sort_values("t_s").reset_index(drop=True)
    df_states_sorted = df_states_small.sort_values("t_state").reset_index(drop=True)

    merged = pd.merge_asof(
        df_motion_sorted,
        df_states_sorted,
        left_on="t_s",
        right_on="t_state",
        direction="backward",
    )
    merged["toPhase"].fillna("idle", inplace=True)
    merged.rename(columns={"toPhase": "phase"}, inplace=True)
    return merged


def plot_motion_with_states(df_motion, taps, title=None):
    """
    Plot y_raw over time, with line segments color-coded by FSM phase.
    Overlay tap candidates (x) and accepted taps (o).
    """
    fig, ax = plt.subplots(figsize=(10, 4))

    # Draw segments by phase
    phases = df_motion["phase"].values
    ts = df_motion["t_s"].values
    ys = df_motion["y_raw"].values

    # Find contiguous runs where phase is constant
    start_idx = 0
    for i in range(1, len(df_motion)):
        if phases[i] != phases[i - 1]:
            phase = phases[start_idx]
            color = PHASE_COLORS.get(phase, "black")
            ax.plot(ts[start_idx:i], ys[start_idx:i], color=color, linewidth=2)
            start_idx = i
    # Last run
    phase = phases[start_idx]
    color = PHASE_COLORS.get(phase, "black")
    ax.plot(ts[start_idx:], ys[start_idx:], color=color, linewidth=2)

    # Overlay tap markers
    if taps:
        # Candidate taps: 'x'
        t_all = [tap["t_s"] for tap in taps]
        y_all = []
        for t in t_all:
            idx_near = (df_motion["t_s"] - t).abs().idxmin()
            y_all.append(df_motion.loc[idx_near, "y_raw"])
        ax.scatter(t_all, y_all, marker="x", s=60, label="Tap candidates", zorder=3)

        # Accepted taps: 'o'
        t_acc = [tap["t_s"] for tap in taps if tap.get("passedScoreThreshold")]
        y_acc = []
        for t in t_acc:
            idx_near = (df_motion["t_s"] - t).abs().idxmin()
            y_acc.append(df_motion.loc[idx_near, "y_raw"])
        if t_acc:
            ax.scatter(t_acc, y_acc, marker="o", s=60, facecolors="none",
                       edgecolors="black", label="Accepted taps", zorder=4)

    ax.set_xlabel("Time (s, relative)")
    ax.set_ylabel("y_raw (vertical)")
    if title:
        ax.set_title(title)

    # Legend for phases
    for phase, color in PHASE_COLORS.items():
        if phase is None:
            continue
        ax.plot([], [], color=color, label=f"State: {phase}")
    ax.legend(loc="best", fontsize=8)

    ax.invert_yaxis()  # optional: up on screen = smaller y
    plt.tight_layout()
    return fig, ax


def plot_velocity(df_motion, ax=None):
    """
    Optional: plot vertical velocity over time, colored by phase as well.
    """
    if ax is None:
        fig, ax = plt.subplots(figsize=(10, 3))
    else:
        fig = ax.figure

    ts = df_motion["t_s"].values
    # approximate velocity from neighbor differences
    y = df_motion["y_raw"].values
    v = [0.0]
    for i in range(1, len(y)):
        dt = (ts[i] - ts[i - 1])
        v.append((y[i] - y[i - 1]) / dt if dt > 0 else 0.0)
    df_motion["v_est"] = v

    phases = df_motion["phase"].values
    start_idx = 0
    for i in range(1, len(df_motion)):
        if phases[i] != phases[i - 1]:
            phase = phases[start_idx]
            color = PHASE_COLORS.get(phase, "black")
            ax.plot(ts[start_idx:i], df_motion["v_est"].iloc[start_idx:i],
                    color=color, linewidth=1.5)
            start_idx = i
    phase = phases[start_idx]
    color = PHASE_COLORS.get(phase, "black")
    ax.plot(ts[start_idx:], df_motion["v_est"].iloc[start_idx:], color=color, linewidth=1.5)

    ax.set_xlabel("Time (s, relative)")
    ax.set_ylabel("v_est (vertical velocity)")
    ax.axhline(0, linestyle="--", linewidth=0.8)
    plt.tight_layout()
    return fig, ax


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--motion", required=True, help="fingertip_motion_*.csv")
    parser.add_argument("--candidates", required=True, help="tap_candidates_*.json")
    parser.add_argument("--states", required=True, help="tap_fsm_states_*.json")
    parser.add_argument("--hand", type=int, default=0, help="handIndex to plot (default 0)")
    parser.add_argument("--finger", type=int, default=8, help="fingerIndex to plot (default 8 = index)")
    args = parser.parse_args()

    df_motion, t0 = load_motion(args.motion, args.hand)
    taps = load_tap_candidates(args.candidates, t0, args.hand, args.finger)
    df_states = load_phase_states(args.states, t0, args.hand, args.finger)
    df_motion_phase = assign_phase_to_samples(df_motion, df_states)

    title = f"Hand {args.hand}, finger {args.finger} (Index finger FSM)"
    fig1, ax1 = plot_motion_with_states(df_motion_phase, taps, title=title)

    # Optional velocity subplot in a separate figure:
    fig2, ax2 = plt.subplots(figsize=(10, 3))
    plot_velocity(df_motion_phase, ax=ax2)
    ax2.set_title("Estimated vertical velocity with FSM state colors")

    plt.show()


if __name__ == "__main__":
    main()
