# Layout transition acceptance

Use this contract when changing rotation, folding, window resizing, chrome allocation, sidebars,
composer geometry, or chat reflow. Check the whole visible window, including system clearance,
headers, content, floating controls, and the bottom input area.

**The current native rotation work is not accepted.** The 2026-11-18 iPhone Duo recording still
contains late top/right clearance changes, title hard cuts, composer changes, and body reflow.
This document records failures to prevent and behavior to preserve; it is not a list of completed fixes.

The current repair keeps the existing layout owners. Verify settled clearance, pane widths,
title fitting, action slots, and menu placement. Check that resize does not add a second
Composer height correction or lose draft text, selection, focus, or reading position. Keep
the whole chat visible in recordings and check disclosures and keyboard behavior.

Defer frame-by-frame coordination between UIKit and Fabric for window clearance and sidebars;
continuous motion for titles, tabs, actions and their menus; continuous Composer shape changes;
and Markdown row reflow. Keep the failure evidence and full acceptance criteria below for
that work. A passing settled-layout or interaction check does not pass the whole-frame contract.

## What fails acceptance

Treat every large, discontinuous change between adjacent frames as a defect candidate. Inspect
it even when it is outside the component you changed. Continuous system rotation and deliberate
user-requested motion still need temporal context; a difference score alone cannot distinguish
them from an extra layout jump.

A transition fails when the window takes its new shape and then independently corrects padding,
replaces chrome, resizes the composer, or rearranges already visible content. The final screenshot
can be correct while the transition fails.

Reduced motion can remove interpolation. It must not introduce several contradictory intermediate
layouts. Some interactions intentionally update without animation, such as
[chat disclosures](agent-stream-disclosure.md#the-contract); preserve their anchor contract.

## Observed failures and verification

The recording contains all four successive rotations, starting in portrait. These are selected
**actual adjacent source-frame pairs** from the first portrait-to-landscape transition:

| Frames, seconds     | Visible failure                                                                                                                                                                              | Required result                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1.108333 → 1.123333 | After the window expands, the right edge of the message moves left by 84pt and navigation/top content moves up by 18pt. About 22% of the downscaled whole-frame pixels change significantly. | New window bounds and their top/right clearance must not paint as separate layouts.                                |
| 1.513333 → 1.518333 | The composer changes to its collapsed landscape shape in another update.                                                                                                                     | The input area must not lag behind the window and surrounding content, then correct its height or row arrangement. |
| 1.590000 → 1.710000 | Title typography, subtitle, and picker/tab presentation switch after the earlier geometry changes.                                                                                           | The title and controls must participate in the visible transition without a delayed hard replacement.              |

Reverse rotation also has isolated body reflow, composer changes, and header replacement. For
example, the body changes between 36.055000 and 36.060000 seconds; another header change occurs
between 46.440000 and 46.531667 seconds. Do not limit investigation to portrait-to-landscape.

The 120ms and approximately 92ms source-frame gaps around two header changes are evidence gaps.
Determine whether they come from application stalls or recording loss before attributing them.
Do not invent the missing intermediate frames or claim that an animation was visible in them.

In a later paired capture, the app's main-thread display-link callbacks missed 196ms and 124ms
at the two landscape entries. Root-stage timing put 42–50ms in the first hosting-view layout
and a further 12–14ms in the inset-only Fabric commit. The UIKit geometry read took under 1ms.
Time Profiler samples include Fabric layout and mounting under the viewport constraint change,
then synchronous RNSScreen bounds and safe-area state commits. Skipping identical RNSScreen
bounds updates did not reduce the first host-layout cost in the comparison run and was reverted.
This attributes part of the cadence loss to app-side work; it does not recover missing frames
or identify the cause of every gap in earlier clips.

A scoped trial combined the actual RNSScreen and RNSSafeAreaView reports from a host resize
in one follow-up Fabric commit. It matched two to four distinct nodes per resize and took
34–64ms including the initial host layout. The title and controls still changed while the
window was nearly upright at 2.433333 → 2.681667 and 10.598333 → 10.736667. Both pairs
bracket capture gaps. The trial was reverted; it does not pass W1, H2, or H6.

The native and React trace showed separate commits for window bounds, chrome, composer, and
chat measurement. The root Fabric hook writes bounds and owned spacers in one candidate, and
React now derives frame, aspect, compact layout, and clearance from one geometry event.

On Duo, UIKit can deliver landscape bounds while the window still reports the portrait safe
area. The window received its right inset before the root probe inherited it, and the final side
occlusion arrived later still. Reading the full-window safe area directly removes the inherited
delay; it cannot make UIKit supply the destination geometry in the first layout pass. The
`transitionCoordinator` read during layout is nil in the captured rotations. Precreating bar
guides and forcing trait updates did not change the ordering. Do not infer clearance from
aspect or add a second writer.
On both Expo's original window and the keyboard-observing replacement, the first layout
reported the new landscape size with zero right clearance. The scene's effective-geometry
callback arrived 71–85ms after that layout, still with a zero right inset and no transition
coordinator. Right clearance reached 84pt at 100–131ms. Both returns first resolved 70pt from
the old bar guide, then cleared it. Neither the scene callback nor removing the keyboard
window substitution provided complete rotation inputs earlier.

The root controller's `viewWillTransition(to:with:)` does receive a coordinator, 49–52ms
before the first resized layout in a portrait → landscape-left → portrait trace. UIKit
accepts `animate(alongsideTransition:)` in both directions even though the layout callback's
coordinator property is nil. On the landscape entry, the alongside block runs about 57ms
before UIKit reports zero top and 84pt right safe area. The callback supplies a transition
context and destination size, not the final clearance.
In a four-pose painted control, a 120pt marker translation registered with that coordinator
tracks the independently measured window angle to within 2.7 percentage points of normalized
progress, without sampled rollback. That isolates an available presentation clock despite the
nil layout-time property. The system safe area still arrives after the alongside block. The
control moved only the marker; it does not establish H6 or W1 for the app's content.
In a retained-action trial, Fabric delivered new button targets 35–95ms after the alongside
block. Copying its Core Animation action at each retarget still reported `beginTime == 0`;
the copy does not establish a common render-server start, and moves paint without updating
Fabric hit and overlay geometry. The trial was reverted, with no H6 or M3 pass claimed.

The passive UIKit phase trace still sees the old safe area at `beforeCATransactionCommit`,
even when the window's edge trait has changed. The view's trait, guide and insets are current
by `afterCATransactionCommit` in that update. That identifies a transition within UIKit's
commit phase, not a missing pre-commit sampling callback. The phase timestamps do not prove
which of those samples was painted.

An Auto Layout control in the native root compares markers attached to its bounds with
markers attached directly to its safe-area guide. On the two landscape entries, the guide's
visible top clearance goes from 82pt to about zero while the top edge is still within 0.3°
of upright (1.376667 → 1.593333 and 10.551667 → 10.706667, with 217ms and 155ms gaps).
On both returns it increases during the visible turn. The system bar covers the trailing
bounds marker at the decisive frames, so the measured safe-area span cannot isolate right
clearance from bounds width there. Moving top clearance to direct UIKit constraints alone
would still expose the early change. All control markers were removed.

The cold Expo runtime uses unqualified adapter names. The original matcher ignored them, so a
mounted 84pt spacer could remain after UIKit had already returned zero. With both forms of adapter
registered, the steady portrait gap is gone on returns from both landscape poses. W1 still
requires checking the transition itself.

In the later four-rotation capture, the unfolded workspace stays on one header row instead of
visiting the full-width two-row layout while waiting for the bar. Controls can still move late.
At 6.053333 → 6.070000 and 12.136667 → 12.155000 seconds, the message body and input area
change after the return to portrait. In the paired native trace, the timeline retains the same
end pin and receives no explicit scroll command during the rotation. The mounted width takes
multiple steps (279 → 349 → 469 → 400pt in portrait), and the virtual list recomputes its content
height at those widths. This confirms independent geometry and body reflow steps; it does not
establish the origin of every intermediate width or verify detached reading position.

An idle Mock conversation on the local dev host completed both rotations and both returns to
portrait. The earlier clip shows a body and composer cut at 8.353333 → 8.361667 and again at
16.571667 → 16.578333. The flex-dock run removes the late 469 → 400pt center correction on
both returns; it still shows body and composer cuts at 7.453333 → 7.465000 and
15.853333 → 15.893333. A dock drag moved the separator and retained its released position;
that check did not cover in-flight motion or interruption.
Publishing the geometry before UIKit lays out the registered roots removed the separate pause
before the correction in one four-rotation run. The two portrait returns still cut the body and
composer at 6.858333 → 6.866667 and 14.926667 → 14.931667 seconds, at the end of system motion.
Title and action placement also still change during the transition.

A React commit trace isolated an empty bar after the horizontal actions left: the vertical
host and its first workspace action mounted 73ms apart. With the action slots registered before
the guide arrives, both landscape poses mount the bar and the workspace action in the same React
commit. The native guide still arrives after the first bounds and composer-mode commit. The
React trace does not establish whole-frame continuity (H6, W1, C1).

The first native candidate applied the guide rectangle, horizontal clearance, and complementary
visibility for the inline and compact workspace action slots together. In that four-pose capture,
the actions settled in the bar in both landscape poses and in the header in both portrait returns.
The landscape workspace menu opened and dismissed on return. The capture still had separate
body and chrome changes, including 6.053333 → 6.060000 and 6.108333 → 6.126667. This did not
pass H6 or M3 in flight, or remove the underlying UIKit bounds/guide ordering (W1).

A later native trace records each landscape destination inserting Git in the still-horizontal
header, moving the overflow trigger right by 52pt. About 40ms later the header controls unmount
as the bar mounts with Git and the overflow trigger already in their intended slots. The bar
then changes its own y origin from 82pt to 124pt. This run does not reproduce the earlier bar
trigger's separate y=0→52pt correction after the window settled; its cause remains unconfirmed.

Use the width left after owned corner clearance for the horizontal Git slot. In the next
four-pose recording, neither sampled landscape entry shows the extra horizontal Git button;
the portrait overflow still contains Commit, Pull, and Push. The header actions still move
to the bar before visible rotation at 2.328333 → 2.358333 and 10.528333 → 10.585000. These
samples do not verify every mount or pass H6.

The inline workspace now uses the same Fabric action views in the title and bar. In the
uncovered four-rotation recording, the overflow trigger retained tag 1156 and its 44×44pt
frame, moving from (413, 25.67) in portrait to (881, 176) in both landscape poses and back.
In the open-menu recording, the menu stays open across all four rotations. Commit, Pull, and
Push are in portrait overflow; landscape uses the independent Git control. The first entry
still changes the header before the window visibly rotates at 3.976667 → 4.125000, across a
148ms capture gap. At 4.401667 → 4.410000 the controls are still changing near the end of the
same entry. H6 and M3 remain open for presentation continuity.

A per-frame action-layer trial read progress from the root's presented bounds while leaving
Fabric's model frames intact. The first landscape progress rolled back from 0.178 to 0.006;
on return it rolled back from 0.303 to 0.001. The full frames show buttons bunching together
in flight. The trial was reverted: root bounds alone are not a monotonic rotation clock, and
sampling them did not synchronize the chrome or preserve its intermediate placement.
In a separate passive capture, all 84 samples of the root, actual `UIWindow`, and its parent
agreed to the recorded precision. The first entry fell from 880.21pt back to 669.51pt, and
the return rose from 861.72pt back to 947.05pt, in both cases without a change in the reported
animation start. All three sampled layer transforms had zero rotation. Switching the sample
from the root to `UIWindow` would not have fixed the rollback in this capture.
In a follow-up capture with temporary layer markers, the first landscape header change is
visible at 1.595000 → 1.638333, before the markers show the window turning. The return shows
another header change at 4.900000 → 4.960000, while the markers are still near 90°. Sampled
root width rolls back at marker updates 11 → 12 and 52 → 53; the identifiable drawn codes go
from 2 → 25 and 45 → 53 through those intervals. The recording does not show a corresponding
painted rollback. Neither the sampled bounds nor the animation start explains the earlier
header changes relative to the visible window angle. The markers are not part of the fix.

The shell menu and header menu now use complementary native slots. The wide full-display Duo
kept one accessible menu in the leading header in the four captured destination poses, while
workspace actions occupied the trailing bar in landscape. This tests the retained leading entry,
not a split-window or leading-bar transfer. A separate header change remains at
17.111667 → 17.118333; the leading menu's settled placement does not pass H6.

The timeline mount trace isolated one part of the cut: at a fixed 400×763pt viewport and zero
scroll offset, both portrait returns moved the rows down another 218pt. With iOS Yoga allocating
the short timeline's headroom, neither return has that extra mount. The body stays near the
end as the viewport changes; the composer and header still switch.

A Composer commit trace measured the same 26pt resting bottom clearance and 16pt keyboard gap
before, during, and after rotation. The first bounds commit changed the collapsed mode before
the side bar guide arrived. Removing a synchronous Reanimated read from the layout effect did
not remove the cuts: an upright portrait return still changed the title, body, and input area
at 10.285000 → 10.288333 seconds. This rules out that read as a sufficient fix (H2, C1, C5).

In the paired native mount trace, the landscape slot shrinks from 118pt to 72pt after the
viewport has its new width. Both portrait returns reverse that step: the slot grows from 72pt to
118pt 160ms and 131ms after the dock and outer viewport settle. The chat viewport loses exactly
46pt in those mounts while the outer viewport stays fixed. The change is in Composer allocation,
not a second bottom inset or a scroll offset correction.

Selecting the retained editor and toolbar layout in the native geometry commit removed the
46pt return correction. The first landscape mount still reserved the enclosing Composer's
75pt portrait minimum. Moving that minimum into the same transaction removed a second 29pt
correction. In the four-pose run the first full-size viewport measures 545pt in landscape and
763pt in portrait, with no later Composer allocation change. A subsequent mount trace catches
the 72↔118pt change at the old pane size, 20–29ms before the pane catches up; both mounts
precede the visible window rotation in that run. These mount timings do not verify the
presented input surface (C1, C2).

With navigation and Explorer closed on the unfolded Duo, the input's left edge previously
returned to its portrait position about 170ms before the right edge. The native trace still
reports 70pt of trailing clearance from the outgoing bar on the first portrait layout. Moving
the balancing inset into the same Fabric candidate is insufficient while the workspace is
pinned to the older React width. With the undivided workspace sized by its native pane row,
both recorded portrait returns reach the final input span (17–651pt at the sampled row) at
5.338333 and 12.155000 seconds, with no later 70pt expansion. Landscape remains centered.
The picker/rail and Composer shape still change during rotation; this does not pass the
whole-frame contract.

The docked landscape gap had a different cause: the sidebar host grew to 321.33pt, but
its fill, divider, and resize grip stayed at 269pt. Composer's centering was disabled.
With the sidebar surface filling the dock's allocation, the grip's trailing edge and the
Composer container's leading edge match at 321.33pt in both landscapes and 269pt in portrait.
Closing navigation in landscape still leaves the conversation centered between 84pt insets.

Temporarily removing the iOS Composer's Reanimated layout registration still shows the toolbar
and header changing before visible rotation at 2.436667 → 2.505000 and 10.723333 → 10.785000.
The first transition also has a 198ms gap later in the motion. The focus animation was restored;
bypassing it does not pass C1 or establish which writer owns the presented border.

The inline title and project line now use the same native aspect selection as the Composer.
Both text tags survive a portrait → landscape-left → portrait round trip. The four-pose
recording still shows a separate header/action and body change at the tail (for example,
7.628333 → 7.631667); retaining the title does not verify picker, overflow, or action allocation.

With an expanded disclosure and a detached reader, both landscape poses and both returns retain
the disclosure and the Scroll to bottom control. A separate round trip from the middle of the
expanded text returns the same paragraph about 10pt higher in the same portrait viewport. This
rules out a jump to the end in that run, but fails exact reading-anchor preservation (C6).

A later four-pose capture at a different reading position returns the native offset to
404.67pt on both portrait returns. Sampled portrait text pixels are identical before and after
that run. The same capture still shows C5: after the landscape viewport reaches 545.67pt wide,
the mounted content height remains about 4,309pt for 338–441ms, then changes to 3,561pt in one
mount. LegendList's adjustment marker and the native offset move together by 88pt in that
mount; adding another offset writer would not eliminate the separate reflow.

A separate JS trace measured seven row-height updates 49–54ms after the first width
invalidation. The final clearance-driven width invalidation came later and produced no
additional size changes in that run. The JS and native traces were separate runs and do not
establish a universal Markdown measurement delay.

The exact Markdown view trace separates measurement from placement in a single run. At
21:55:44.539, the mounted viewport expands to 629.67pt and Markdown tag 1740 goes from 595pt
to 441pt tall in the same transaction. At the final 545.67pt width it becomes 485pt tall, with
its old vertical position and the old 4,309pt scroll extent. The placement/extent correction
comes 302ms later (224ms in the other landscape pose). A change to measurement alone cannot
remove this correction. The existing offset writer compensates in the placement transaction.

Folding to the 466pt cover viewport kept the Fabric editor tag but dismissed the keyboard.
The native blur stack led through Fabric's `unmountChildComponentView`: the compact-only
composer shadow changed the native stacking boundary and reparented the editor. Retaining
that boundary preserves the same native tag, draft text, nonempty 0–10 selection, focus, and
software keyboard on an unfolded → cover → unfolded portrait round trip. This covers one
C3 configuration; the composer and title motion still need whole-frame acceptance.
An empty editor retained its native tag, focus, and settled keyboard from landscape-left to
portrait after the synchronous read was removed. With both editor height caps in the native
slot, a wrapped 2,374-character draft retained the same native tag, exact text, and selection
2368–2374 in both landscapes and both portrait returns. The keyboard was visible at each
settled check; it disappears during rotation (for example, at 3.483333 → 3.501667) while
the Composer remains lifted. At 2.650000 → 3.033333 the selected text also stops painting in
an upright frame, across a 383ms capture gap. C3/C4 are not accepted from the readbacks alone.

The empty editor also shows the keyboard disappearing during rotation. In a separate event
trace, React Native and Keyboard Controller both receive a zero-height hide followed by show
without loss of the focused input. On the portrait return the RN hide and next show are read
back about 40ms apart, with 68pt and 350pt show heights in the same JS turn. These event times
do not establish the exact presented frame or which callback moved the Composer. Rotation
during a focus animation remains untested.

The native editor candidate also selects the placeholder, trailing text reserve, and
Fullscreen slot with the toolbar. The empty editor shows the appropriate prompt in all
four settled rotations. On the Duo cover display, a wrapped draft exposes Fullscreen; the
button enters, the draft remains focused across both directions, and Exit fullscreen returns
to the inline editor. The idle capture still changes the header at 1.573333 → 1.608333 and
9.640000 → 9.695000 before visible turning. The Composer and title transition remain open.

Two earlier Settings runs left the app during rotation due to a Fabric root-props assertion;
Home Screen frames do not count as Settings evidence. A separate workspace exit reached a
Yoga layout assertion.
After switching to Fabric's root-constraint constructor, Settings completed all four rotations
in the rebuilt client without a debugger attached. This verifies process survival in that run,
not Settings layout continuity or the separate workspace assertion.

The later Settings General recording keeps the selected detail through all four rotations.
In settled landscape-left, its Back row and the workspace's New workspace row both center near
y=30pt. The first Settings rotation still narrows the detail and clips the title of its Language
row while the frame is in portrait (1.353333 → 1.460000), before the visible rotation proceeds.
The 107ms capture gap does not identify which intermediate frames painted. W4 remains open.

Moving first-row corner and status clearance into the same Fabric candidate as the surface
spacers does not remove this Settings change. The shared-chrome build still paints the narrowed
detail and shortened sidebar before the visible rotation, at 1.345000 → 1.461667. The capture
keeps General selected through both landscape poses and both portrait returns. W4 remains open.

In the Settings presentation trace, UIKit's animated resize changes the detail target from
400pt to 631pt. A later native inset commit sets 547pt outside the inherited animation block,
but the installed animation still applies its original −231pt starting offset. Presented
width starts near 317pt even though the window has barely started moving. The portrait returns
likewise retain an extra 70pt of leading offset. In the instrumented trial, rebasing the target
deltas onto the pending UIKit timing removes those two pane excursions. The first uninstrumented
recording still shows early sidebar shortening; this is not a W4 pass.

Moving the pending-action rebase to Fabric's pre/post-mount callbacks still leaves the header
changing while the window is nearly upright in both landscape entries. The first change spans
2.643333 → 2.860000, including a 217ms capture gap. The mount-boundary trial was reverted.

The early sidebar cut at 1.376667 → 1.518333 leaves text on the previous frame while the
one-sided border's Fabric background layer jumps to the destination height. After separating
the divider, the background still reaches the window edge as the first rotation becomes
visible, and General remains selected through all four rotations. The first 85ms sampling gap
and the visible detail text rewrap leave W4 open.

The workspace sidebar exhibited the same background cut while footer controls still occupied
their old positions. After separating its divider, the four-pose run shows the background
tracking the pane, and the resize handle remains present. The title/project row already changes
at 1.373333 → 1.480000 while the window is still nearly upright, and header and Composer
changes remain visible in the neighbouring animation frames. H2, H6 and C1 remain open.

The native title trace shows its target width changing from 24 to 254, 358, then 418pt while
the window still presents portrait bounds. Both portrait returns briefly target a 0pt title
with the old 148pt action group still in the row. Keeping the project row mounted in a
collapsible layout slot lets its rendered height start at zero and grow while the window
rotates. It does not fix the transient title budget, font redraw, or picker/rail handoff.

An inline header layout trial uses the pane width allocated by parent Yoga and the row's current
clearance and action slots. Choosing the title metrics and Git slot there removes the 0pt target:
at 400pt on both returns, it measures 128pt before the bar leaves and 24pt when two header actions
return. The candidate rail budget crosses the 320pt floor (328pt at a 630pt pane, then 250pt
and 304pt at 546pt), but the mount receipts keep the picker in every recorded mount. On both
landscape entries, the first mount pairs 951pt bounds with no right spacer. The next mount
pairs an 84pt spacer with the 546pt pane all the way through both native stacks. In both
portrait returns, the 400pt pane stays fixed while the trailing guide clears and the title
changes from 128pt to 24pt. The full-frame captures still show text and control changes;
H1, H2, H6 and W1 remain open.

The iOS inline title lays out its full single line inside a separate clipping viewport. The
native allocation selects the existing trailing scrim with the title and action widths instead
of waiting for a React width estimate. The settled portrait crop matches the earlier treatment;
the four-pose capture still shows separate changes at 6.446667 → 6.450000 and
13.413333 → 13.418333. This does not pass H2 or H6.

The iOS header now measures the retained project line and title in its native row allocation;
it no longer receives a second budget from hidden React title measurements. With navigation
closed, the landscape rail and New tab control are reachable, and a previously open tab picker
closes and does not reopen on the portrait return. In the docked four-pose recording, the
second landscape still changes the header and Composer before the window visibly turns
(11.218333 → 11.315000). The first entry has a 182ms capture gap. H2 and C1 remain open.

The same iOS header allocation now selects the title font and project-row height before
measuring the title and distributing the tab and action slots. The project row is visible
and accessible in both settled landscapes, and absent from accessibility in both portrait
returns. The project content and picker retain Fabric tags 820 and 862 through a separate
portrait → landscape → portrait check. On the final build, the open picker retains New
terminal through the same round trip, and tapping the backdrop dismisses it. The first entry
in the four-pose recording still changes the title and Composer while the window is nearly
upright at 1.488333 → 1.595000, across a 107ms capture gap. H2 and C1 remain open.

The mounting observer also sees paragraph state updates with identical glyph bounds after
the window starts moving. A state revision alone does not establish a change in glyph pixels.
Keeping the gradient mounted and moving it beyond the clipping edge does not remove the tail
change (13.738333 → 13.748333 in the four-pose trial). The gradient movement was reverted.

A retained-glyph trial replaced the font-size swap with a transform and sized the text viewport
from the same native allocation. The header still changes while the window is nearly upright
at 11.718333 → 11.853333. On the first landscape destination, the timeline changes at
3.386667 → 3.395000 after the window has stopped turning. The first entry has a 203ms capture
gap. The transform trial was reverted; H2 and the whole-frame transition remain unverified.

With the two-tab switcher open, rotation originally left its popover at the landscape x≈531pt
on both 669pt portrait returns, clipping its rows and the New terminal control. Recomputing
placement on native modal host layout keeps the popover open and restores its full contents in
each settled pose; tapping the backdrop dismisses it. The final portrait return still moves the
popover in separate steps at 13.733333 → 13.741667 and 13.828333 → 13.836667. M3 remains open.

The open Composer attachment menu reproduced a different stale anchor: both landscapes
kept the backdrop but lost all four rows. Measuring again when the native modal lays out
restores the four rows in both landscapes and both portrait returns; the backdrop still
dismisses. In both portrait returns the menu separately jumps from the middle of the body
back to the attachment button at 5.720000 → 5.723333 and 13.558333 → 13.571667. M3 remains open.

With navigation closed, the landscape pane can show the tab rail. An open picker used to
vanish when the rail took over and reopen on the next portrait frame. The retained picker
slot now closes that menu when it loses its anchor. The picker is reachable again on return
without reopening the menu. With navigation docked and the picker still visible, the menu
stays open in all four settled poses. These checks do not pass the in-flight H1 or M3 criteria.

With Explorer open to Changes, the original dock mounted at 240pt on both portrait returns,
then corrected to 309pt. Removing only the projected workspace width made the center grow to
429pt before returning to 360pt: the Explorer clamp still used the old width. With the dock
measured by the native row, both recorded portrait returns mount the settled 309pt Explorer and
360pt center directly, even while React still observes 599pt of available width. The first
landscape still changes the rail and Explorer contents at 4.241667 → 4.246667, after the frame
has stopped turning. This does not pass W1, H6, or the full P1 check.

A static text-overflow gradient is not a title transition animation. Correcting its width or
removing a stale gradient does not demonstrate that changing the title, font size, subtitle, or
header mode is continuous.

### Local evidence

The investigation artifacts are ignored local files, not portable documentation dependencies:

- `.dev/padding-investigation-rotation.mp4`: 49.95 seconds, 3,042 source frames.
- `.dev/padding-investigation-actual-adjacent-diff.json`: all 3,041 consecutive source-frame comparisons.
- `.dev/padding-investigation-event-index.json`: 14 large-difference clusters, including continuous
  system rotation as well as isolated application changes; this is not a count of 14 confirmed bugs.
- `.dev/padding-investigation-all-events-1.png` and `-all-events-2.png`: full-frame before/after/diff
  overviews for every cluster.
- `.dev/padding-investigation-diff-native-insets.png`, `-diff-composer.png`, and `-diff-header.png`:
  larger full-frame comparisons for the first transition.
- `.dev/artifacts/rotation-shared-final.mp4` and `.adjacent.json`: four idle workspace rotations,
  1,137 source frames and 1,136 adjacent comparisons. `rotation-shared-final-tail.png` shows full
  frames from the isolated pairs; neither the header nor the body is accepted from this clip.
- `.dev/artifacts/rotation-scroll-trace.log`: geometry and pinned scroll mounts on Duo.
- `.dev/artifacts/window-insets-static.mp4`: Settings in both directions, with residual header
  movement; it is not evidence for New workspace, History, or Schedules.
- `.dev/artifacts/rotation-local-mock.mp4` and `.adjacent.json`: 1,362 source frames, 1,361
  adjacent comparisons. `rotation-local-mock-tail.png` shows whole-frame tail pairs.
- `.dev/artifacts/rotation-local-settings-rebuilt.mp4`: Settings run interrupted by app exit.
- `.dev/artifacts/settings-root-props-fixed.mp4` and `.adjacent.json`: rebuilt Settings run,
  392 source frames and 391 adjacent comparisons.
- `.dev/artifacts/rotation-settings-general.mp4` and `.adjacent.json`: 416 source frames, 415
  adjacent pairs, with `-overview.png`, `-overview-diff.png`, and settled screenshots.
- `.dev/artifacts/rotation-shared-native-chrome-settings.mp4` and `.adjacent.json`: 436 source
  frames and 435 adjacent pairs, with `-overview.png` and settled screenshots.
- `.dev/artifacts/rotation-settings-presentation.mp4` and `.adjacent.json`: 341 source frames,
  340 adjacent pairs. The companion `.native.log` and `rotation-settings-actions.native.log`
  distinguish mounted targets, UIKit additive actions, and sampled presentation bounds.
- `.dev/artifacts/rotation-settings-retarget.mp4` and `.adjacent.json`: instrumented trial,
  424 source frames and 423 adjacent pairs. `rotation-pending-transition-settings.mp4` is the
  first uninstrumented run, 391 source frames and 390 adjacent pairs.
- `.dev/artifacts/rotation-settings-sidebar-layer.mp4` and `.adjacent.json`: 396 source frames
  and 395 adjacent pairs, with `-overview.png` and settled Settings screenshots.
- `.dev/artifacts/rotation-workspace-sidebar-layer.mp4` and `.adjacent.json`: 1,184 source
  frames and 1,183 adjacent pairs, with `-overview.png` and `-tails.png`.
- `.dev/artifacts/rotation-header-timing.mp4` and companion `.native.log`: 1,214 source frames
  and 1,213 adjacent pairs. `rotation-project-row-slot.mp4` and companion `.native.log` trace
  the retained project slot, with 1,195 frames and 1,194 adjacent pairs.
- `.dev/artifacts/rotation-header-width-island.mp4` and `.adjacent.json`: 1,329 source frames and
  1,328 adjacent pairs. `rotation-header-width-island-coupled.mp4`, `.native.log` and `.adjacent.json`
  record both directions with the native metric and Git inputs, 1,270 frames and 1,269 adjacent pairs.
- `.dev/artifacts/rotation-header-clearance` and `rotation-header-clearance-mount`: native
  geometry, candidate and mount receipts paired with full-viewport video and adjacency data
  (1,359 and 1,337 source frames, respectively). The first landscape sample in the clearance
  clip skips 168ms; the receipts do not fill that gap in painted evidence.
- `.dev/artifacts/rotation-intrinsic-title-glyphs.mp4` and `rotation-native-title-overflow.mp4`
  with adjacency data (1,314 and 1,286 source frames). The native overflow overview and title
  details show in-flight clipping; `-settled-compare.png` compares the stable portrait crops.
- `.dev/artifacts/rotation-retained-title-scrim.mp4`: the reverted gradient movement trial,
  with 1,299 source frames and 1,298 adjacent comparisons.
- `.dev/artifacts/rotation-title-glyph-scale`: 1,507 source frames and 1,506 adjacent pairs
  for the reverted font-scale trial, with full-frame overview, tail, and difference sheets.
- `.dev/artifacts/rotation-header-unified`: 1,356 source frames, 1,355 adjacent pairs, and
  a whole-frame overview, settled accessibility captures, and a separate identity log.
- `.dev/artifacts/rotation-open-tab-switcher.mp4` and `.adjacent.json`: 1,293 source frames and
  1,292 adjacent pairs. `rotation-tab-switcher-reanchor.mp4` and `.adjacent.json`: 1,308 source
  frames and 1,307 adjacent pairs, with full-frame `-pairs.png` and settled screenshots.
- `.dev/artifacts/rotation-attachment-menu-before` and `rotation-attachment-menu-native-viewport`:
  1,327/1,326 and 1,311/1,310 source frames/adjacent pairs, settled screenshots and accessibility
  snapshots. The latter includes full-frame overview and adjacent portrait tail pairs.
- `.dev/artifacts/rotation-native-title-open-picker-rail.mp4` and
  `rotation-retained-picker-rail.mp4`: the picker-to-rail handoff before and after the lifecycle
  fix, with 216 and 217 source frames. `rotation-retained-picker-docked.mp4` has 1,247 frames
  across four poses with the picker still present; the accompanying AX captures show the menu
  contents after each rotation.
- `.dev/artifacts/rotation-undocked-shared-width`: 414 source frames and 413 adjacent pairs,
  with a whole-frame overview. `rotation-undocked-center-trace` preserves the earlier
  candidate trace and the late correction before removal of the React width write.
- `.dev/artifacts/rotation-dock-fill-width-*`: settled Duo screenshots and Fabric edge
  measurements for portrait, both landscapes, and landscape with navigation closed.
- `.dev/artifacts/rotation-header-intrinsic-owner`: 1,479 source frames and 1,478 adjacent pairs,
  full-frame overview and difference sheets, plus undocked portrait and landscape screenshots.
- `.dev/artifacts/rotation-native-mount-paint`: native mount mutations and Core Animation
  timing alongside 1,303 source frames and 1,302 adjacent comparisons. The overview retains
  the full viewport.
- `.dev/artifacts/rotation-window-mount-rebase`: 1,479 source frames, 1,478 adjacent pairs,
  and full-frame overview and difference sheets for the reverted mount-boundary trial.
- `.dev/artifacts/rotation-main-cadence` and `rotation-root-stages`: app cadence and stage timings
  with 1,413 and 1,456 source frames. `rotation-root-time-profile-duo.trace` holds native stacks;
  `rotation-screen-dedup` holds the reverted trial with 1,425 source frames.
- `.dev/artifacts/rotation-screen-batch-guarded`: 1,453 source frames, 1,452 adjacent pairs,
  frame sheets, and host/batch timing. `rotation-screen-batch` records the earlier failed
  prototype; its crash report identifies an out-of-range state lookup for an ancestor clone.
- `.dev/artifacts/rotation-bar-field-trace`: 1,144 source frames, 1,143 adjacent pairs, and the
  native mutation log for the bar host, Git slot, and overflow triggers.
- `.dev/artifacts/rotation-header-git-corner`: 1,421 source frames, 1,420 adjacent pairs,
  full-frame comparisons, and the detail sheet for both landscape entries.
- `.dev/artifacts/rotation-native-explorer-open` and `rotation-explorer-native-row`: baseline
  and reverted outer-width-only Explorer recordings, with 554 and 544 source frames.
  `rotation-explorer-measured-dock` covers 577 frames and 576 adjacent pairs, with a whole-frame
  pair sheet and a separate React commit trace of mounted Fabric metrics.
- `.dev/artifacts/rotation-dock-flex.mp4` and `.adjacent.json`: 1,150 source frames, 1,149
  adjacent comparisons. `rotation-dock-flex-tail.png` shows remaining cuts.
- `.dev/artifacts/rotation-early-publication.mp4` and `.adjacent.json`: 1,289 source frames,
  1,288 adjacent comparisons. `rotation-early-publication-tail.png` shows affected whole frames.
- `.dev/artifacts/rotation-timeline-mount.native.log` and
  `.dev/artifacts/rotation-native-end-alignment.native.log`: before/after timeline mounts.
  `rotation-native-end-alignment.mp4` and `.adjacent.json` cover 1,268 source frames and 1,267
  adjacent comparisons; `rotation-native-end-alignment-tail.png` shows the remaining cuts.
- `.dev/artifacts/rotation-detached-disclosure.mp4` and `.adjacent.json`: 1,463 source frames and
  1,462 adjacent comparisons. `detached-middle-*.png` shows the mid-paragraph round trip.
- `.dev/artifacts/fold-editor-responder-stack.log` shows the native removal that ended editing;
  `fold-selection-live-*.png` shows the selected draft before, during, and after the fixed fold.
- `.dev/artifacts/composer-retained-slots-*.png` shows the retained toolbar slots in both poses.
  The attachment and model controls keep their Fabric tags during rotation; this does not check
  in-flight placement or open-menu behavior.
- `.dev/artifacts/rotation-toolbar-react-commits.log` and
  `rotation-retained-action-host.commits.log`: before/after portal handoffs. The after video and
  `.adjacent.json` cover 1,301 source frames and 1,300 adjacent comparisons.
- `.dev/artifacts/rotation-native-bar-complete.mp4` and `.adjacent.json`: 1,185 frames and 1,184
  comparisons with the guide and action slots in one native candidate. `-motion.png`,
  `-tail.png`, and `-tail-diff.png` retain the whole viewport. `window-bar-native-menu-*.png`
  shows the landscape menu and portrait dismissal.
- `.dev/artifacts/rotation-retained-action-plane-{idle,open-menu}.mp4` and `.adjacent.json`:
  1,540/1,539 and 2,016/2,015 frames/pairs respectively. The idle `-adjacent-samples.png` and
  `.identity.log` pair whole-frame evidence with settled Fabric identity and layout readbacks.
- `.dev/artifacts/rotation-presented-action-clock`: 1,227 source frames, 1,226 adjacent pairs,
  sampled root progress, and full-frame strips for the reverted presentation trial.
- `.dev/artifacts/rotation-window-clock-probe`: 635 source frames, 634 adjacent pairs, and
  simultaneous root, `UIWindow`, and parent presentation samples.
- `.dev/artifacts/rotation-pixel-clock`: 610 source frames, 609 adjacent pairs, native samples,
  decoded optical markers, and a whole-frame strip for the instrumented comparison.
- `.dev/artifacts/rotation-scene-{observed,original}`: 640/639 and 585/584 source frames/pairs,
  with geometry timings for the keyboard-observing and original Expo window respectively.
- `.dev/artifacts/rotation-uikit-guide-control`: 1,430 source frames, 1,429 adjacent pairs,
  an overview of all four turns, and 1,363 frames with three measurable marker centers.
- `.dev/artifacts/rotation-controller-callback.native.log` records the root controller callback.
  `rotation-controller-motion` contains 1,087 source frames and 1,086 adjacent pairs, with
  988 frames containing all three markers, a native trace, and whole-frame overview.
- `.dev/artifacts/rotation-coordinator-actions` records the reverted button trial: 1,331 source
  frames, 1,330 adjacent pairs, whole-frame strips, and the target/action trace.
- `.dev/artifacts/rotation-native-navigation.mp4` and `.adjacent.json`: 1,494 frames and 1,493
  comparisons, with settled screenshots and accessibility snapshots of each destination.
  `-overview.png`, `-overview-diff.png`, and `-tail.png` show the full frames.
- `.dev/artifacts/rotation-composer-border-direct`: 1,350 source frames, 1,349 adjacent pairs,
  and full-frame comparisons for the reverted layout-registration trial.
- `.dev/artifacts/rotation-composer-viewport-cap`: 2,737 source frames, 2,736 adjacent pairs,
  full-frame comparisons, and per-pose editor readbacks for the selected wrapped draft.
- `.dev/artifacts/rotation-composer-editor-chrome`: 1,335 source frames, 1,334 adjacent pairs,
  with whole-frame strips and settled editor screenshots. `composer-editor-chrome-cover-*`
  records the compact Fullscreen interaction.
- `.dev/artifacts/rotation-empty-keyboard-events`: 1,315 source frames and 1,314 adjacent pairs.
  Use `rotation-keyboard-notifications.log` for the separate labeled keyboard event trace.
- `.dev/artifacts/rotation-markdown-fabric.log`, `.mp4`, and `.adjacent.json`: 1,301 frames
  and 1,300 adjacent comparisons with exact Markdown tags and mounted frame geometry.
- `.dev/artifacts/rotation-shared-native-chrome-workspace.mp4` and `.adjacent.json`: 1,443
  frames and 1,442 comparisons. The experimental sidebar wrapper narrowed its navigation
  labels in portrait; the wrapper was reverted. `-overview.png` retains the failed frames.
- `.dev/artifacts/rotation-composer-clocks.log` records the React window and Composer mode
  handoff. `rotation-composer-unblocked.mp4` and `.adjacent.json` cover 1,565 source frames and
  1,564 adjacent comparisons; `rotation-composer-unblocked-cuts.png` shows the large cuts.
  `composer-focus-unblocked-*.png` shows the focused editor before and after the portrait return.
- `.dev/artifacts/rotation-coupled-native.log` records the window, dock, Composer slot, and chat
  viewport in the same run. Its video and adjacency data cover 1,174 frames and 1,173 comparisons.
- `.dev/artifacts/rotation-composer-native-container.log`, its video, and `.adjacent.json`:
  Composer and chat after the native allocation cutover, 1,167 frames and 1,166 comparisons.
  `rotation-composer-native-slot-detail.log` isolates the previous landscape minimum.
- `.dev/artifacts/rotation-retained-title.mp4` and `.adjacent.json`: 1,526 source frames and
  1,525 comparisons after retaining the title and project row. `-tail.png` shows paired frames;
  `-tags.log` records their Fabric identities.
- `.dev/artifacts/rotation-frame-phase.log`: UIKit layout and Core Animation phase samples.
  `rotation-root-coupled.mp4` and `.adjacent.json`: 1,171 frames and 1,170 comparisons for the
  reverted synchronous root-resize experiment. The first rotation has a 448ms capture gap;
  a later 2.915000 → 2.931667 cut is present in the recorded frames.
- `.dev/artifacts/detached-offset-mount.log`, its video, and `.adjacent.json`: the detached long
  disclosure trace, 1,456 frames and 1,455 comparisons. `-before.png` and `-portrait.png` show
  the same reading position in that run.
  `reflow-js-stages.log` is the separate JS measurement trace.
- `.dev/artifacts/workspace-bar-menu-*.png`: the landscape menu is reachable and dismisses on
  return to portrait. This does not check the menu's in-flight frames (M3).
- `.dev/artifacts/rotation-mount-events-rows.json` and `rotation-dock-flex-rows.json`: measured
  dock and composer widths before and after moving the clamp into the native layout.

Scores use the complete image downscaled to 334×475 grayscale, with significant change defined as
an absolute difference greater than 20. Frames retain their original timestamps and adjacency;
there is no temporal resampling, region mask, or interpolation. Those analysis values are not
product constants or an acceptance threshold. Smaller visible defects also fail acceptance.

## Regression inventory

Every row is a required check. Rows beyond the confirmed recording above describe regression
requirements, not claims that every failure was reproduced in that recording or already fixed.

### Window clearance and page chrome

| ID  | Avoid                                                                                                                         | Preserve/check                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | New bounds paint with old left/right clearance, followed by a horizontal content jump.                                        | Inspect both window edges and the content width throughout rotation, folding, split-window changes, and resizing.                                           |
| W2  | Top clearance is added, removed, or corrected after the window changes shape.                                                 | Header, first navigation row, Explorer rail, and page content must not take separate vertical correction steps.                                             |
| W3  | Safe area, reserved system bar, or rounded-corner avoidance is consumed twice or temporarily omitted.                         | Check leading/trailing bar configurations, windows without a bar, and corner ownership transfers. Controls must remain visible and reachable.               |
| W4  | Workspace looks correct while New workspace, History, Schedules, or Settings still jumps or uses different alignment.         | Check every destination. Settings' first row must align with outer navigation at the same pose. Correct final padding does not prove transition continuity. |
| W5  | Opening a sidebar changes system status visibility or moves navigation/actions into a different coordinate frame for a frame. | Check system regions and window-bar controls as well as the application content.                                                                            |
| W6  | A window resize or focus change leaves native borders/clipping at an old size despite correct reported bounds.                | Inspect painted edges; Fabric rectangles and React props alone do not prove the final frame was mounted.                                                    |

Clearance ownership and final alignment rules live in
[the window chrome contract](explorer-sidebar.md#panel-host-contract).

### Titles, tabs, and actions

| ID  | Avoid                                                                                                                               | Preserve/check                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | The tab-count button first moves far away from the title, then becomes a tab rail.                                                  | Check the full path from picker to tabs and back, not only the two settled modes.                                                          |
| H2  | Title text, font size, subtitle, or project row hard-cuts after rotation or appears in a separate correction step.                  | Check the title's actual pixels, line placement, allocation, and accompanying controls together. A correct overflow scrim is insufficient. |
| H3  | A stale gradient clips a title that now fits, or a newly overflowing title paints without its intended clipping.                    | Check both title variants and changes in title, project, loading state, typography, and font scale.                                        |
| H4  | Cold or invalidated measurements select a temporary header mode, rail width, or title budget before switching again.                | Check cold and warm content, long titles, loading completion, one/many tabs, and presentation changes unrelated to viewport width.         |
| H5  | An old native width survives a flexible presentation, title text paints over actions, or a hidden duplicate header becomes visible. | Inspect the entire header and adjacent rows for overlap, clipping, duplicate controls, and empty bands.                                    |
| H6  | The + control, Git actions, overflow control, or system-bar actions move through an extra slot or disappear between modes.          | Check their positions while tab count, allocated width, dock visibility, and action placement change.                                      |
| H7  | Reading/disclosure updates or background tab state cause a visible header remeasurement and mode change.                            | Unrelated content state must not perturb title/rail allocation.                                                                            |

For the existing scope and layout rules, see
[workspace headers and Explorer](explorer-sidebar.md#explorer-sidebar).

### Sidebars, gestures, and retained panels

| ID  | Avoid                                                                                                                                     | Preserve/check                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| P1  | Explorer opens at a previous or clamped width, then corrects; the header briefly uses the full workspace width.                           | Dock frame, center allocation, corner ownership, and header presentation must remain coherent through open/close. |
| P2  | Navigation yields to Explorer late, returns late, or changes its saved dock preference while temporarily overlaid.                        | Check the allocation boundary in both directions and navigation's restoration after Explorer closes.              |
| P3  | A resize handle or pane snaps back to stale React width on release, then returns to the gesture's final width.                            | Inspect drag progress, release, final native frame, and the next React update.                                    |
| P4  | Panel motion and backdrop disagree; both sidebars appear active; controls switch at a different point from their panel.                   | Check open, close, cancel, reverse, and command interruption, including window-bar navigation/close controls.     |
| P5  | Rotation, folding, or docking restarts a drag, reopens a closed overlay, resets a retained scroll position, or detaches its gesture host. | Preserve panel intent and mounted interaction ownership across geometry changes.                                  |
| P6  | A native panel remount, appearance change, or reordered retained root causes a flash, blank area, lost gesture, or stale frame.           | Check active and retained content after the transition and after appearance hydration.                            |

Panel motion and interruption rules live in [mobile panels](mobile-panels.md).

### Composer, keyboard, and chat

| ID  | Avoid                                                                                                                            | Preserve/check                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | Composer collapse/expansion, toolbar rows, padding, or height change in a separate late step after rotation.                     | Check focused and unfocused inputs, empty and multiline drafts, portrait/landscape, and fullscreen.                                                    |
| C2  | An in-flight focus animation survives resize with stale dimensions, snaps back, overshoots, or leaves a stale painted frame.     | Rotate or resize during focus, blur, settings interaction, and interrupted motion; inspect the final border and clipping too.                          |
| C3  | Rotation remounts the editor, loses draft text or selection, moves the caret unexpectedly, or changes focus.                     | Compare full draft text, native editor identity, selection, focus, and keyboard state before and after. Text equality alone does not verify selection. |
| C4  | Keyboard motion moves the list and composer separately, adds a second inset later, or changes the reading offset after settling. | Check keyboard arrival/dismissal while following, detached, and holding a disclosure.                                                                  |
| C5  | Native text reflows first and row measurements catch up later, moving paragraphs, previews, or neighbouring rows again.          | Inspect the entire message list, long messages, Markdown, code/diagrams, and content revealed at the bottom.                                           |
| C6  | Rotation or composer resizing changes a detached reader's anchor, jumps to the end, or makes an end-following list bounce.       | Check both row-relative reading position and end following. Do not substitute one for the other.                                                       |
| C7  | A disclosure, new output, or history load displaces the trigger/reading row, briefly overlaps its neighbour, or blanks content.  | Preserve the existing disclosure hold and scroll ownership during concurrent geometry changes.                                                         |
| C8  | Centering or width constraints are applied twice around a hinge, narrowed pane, or code/diagram viewport.                        | Inspect actual content placement and selection boundaries, not just the outer viewport rectangle.                                                      |

Reading/disclosure and keyboard ownership live in
[agent stream disclosures](agent-stream-disclosure.md#native).

### Modals and shared surfaces

| ID  | Avoid                                                                                                                                                        | Preserve/check                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| M1  | A sheet or popover briefly uses its parent window's safe area, bar width, or top padding before switching to local geometry.                                 | Check modal-local placement, keyboard motion, and touch targets in both orientations.                       |
| M2  | Opening a nested sheet, going Back, or closing the top sheet remounts or flashes the underlying panel, duplicates chrome, or resets its scroll/editor state. | Exercise the actual nested flow; a wide popover does not verify a compact sheet.                            |
| M3  | Menus, tooltips, backdrop, and their anchor settle at different positions after layout changes.                                                              | Inspect full-window placement, clipping, hit testing, and dismissal while the owning pane changes size.     |
| M4  | Theme/font changes replay stale geometry or interrupt a running transition with an old frame.                                                                | Check appearance changes on a live workspace with active animations and retained panels, not only Settings. |

Modal and menu contracts live in [floating panels](floating-panels.md) and [menus](menus.md).
Native style/animation writer constraints live in [Unistyles](unistyles.md#native-animation-commits).

## Capture matrix

Cover these axes when accepting rotation or allocation work. Combine cases where useful, and
record which combinations remain untested rather than claiming a complete pass:

- Both rotation directions and both landscape poses; rapid reversal before the previous transition
  settles. Include folding/unfolding and interactive window resizing when the change affects them.
- Workspace agent, terminal, Files, and Changes tabs; New workspace, History, Schedules, and Settings.
- Navigation open/closed, docked/overlaid/yielded; Explorer closed, opening, open, resizing, and closing.
  Check docked and closed navigation separately on the same unfolded display. With the dock open,
  compare the painted divider and resize grip with the workspace's leading edge. With both sidebars
  closed, check the centered conversation and Composer in landscape, and compare both input edges
  through each portrait return to catch a second width correction.
- Cold and warm content; empty/loading/long titles; one and many tabs; changed typography/font scale.
- Empty and multiline drafts; focused/unfocused input; keyboard visible/hidden; fullscreen where supported.
- Chat following the end, detached in history, expanded disclosures, and incoming output/history.
- A wide popover and a compact sheet, including a nested sheet's Back/Close flow.
- Geometry and appearance changes that interrupt a gesture or focus animation.

Restore only your own temporary changes. Do not overwrite a pose or preference the user changed
while you investigated. Keep draft text, selection, reading state, and saved dock intent intact.

## Whole-frame verification

1. Record the complete viewport before the action starts and until all later layout work settles.
   Capture the first/cold transition as well as repeated transitions. Keep platform, device, build,
   start state, and action sequence with the evidence.
2. Decode every actual source frame and compare each adjacent pair across the whole image. Preserve
   original timestamps and frame intervals. Do not interpolate, temporally resample, mask changing
   regions, or discard the right edge, navigation, composer, or system clearance before finding candidates.
3. Generate before/after/difference views for every large-change cluster. Include the whole viewport
   in the overview; make enlarged regional views only after that inventory exists. Check gradual
   motion for pauses and abrupt velocity changes as well as isolated single-pair spikes.
4. Separate continuous system motion from late application corrections by examining neighbouring
   frames. Keep both in the evidence. Also inspect visible small shifts that fall below the chosen
   difference threshold; scores only locate candidates.
5. Trace each discontinuity through geometry acquisition, native state updates, React commits,
   measurement feedback, and mounted/presented frames. Label a proposed cause as unconfirmed until
   the runtime evidence supports that attribution. Matching final props or a coherent snapshot does
   not establish coherent presentation.
6. Check text, selection, focus, reading anchors, gestures, and hit targets after the transition.
   A clip that looks smooth but loses interaction state fails.
7. Report each inventory item as failing, verified with evidence, or untested for the recorded
   configuration. State capture gaps and unresolved attribution. Keep failed runs; a later clean
   run does not erase an earlier unexplained failure.

Do not accept a transition from settled screenshots, a cropped header contact sheet, a video preview
grid, a count of successful rotations, source-only review, or passing layout arithmetic tests.
None of these covers the complete painted transition.

Do not hide an intermediate layout with opacity gates, blank frames, remounts, clipped stale
content, or a new animation that merely conceals a late correction. Fixing one inventory item must
preserve the contracts linked above and the other items in the matrix. Upstream behavior is not an
acceptance baseline; preserve local fixes that protect those behaviors.
