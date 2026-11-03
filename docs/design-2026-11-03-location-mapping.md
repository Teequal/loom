# Location mapping (design, 3 Nov 2026)

Jacob: Loom keeps bringing people into scenes they haven't been set up to be in ("Zara comes from the shadows"); it should be "there's a rustling in the shadows, roll X". Positions should be on a map with coordinates, so routes and distances are worked out, not remembered.

## What's there today

Places only nest inside each other (a room in a building in a district in a city). "Nearby" used to mean anywhere inside the same place, so with the party recorded "in Duradan", everyone in the city was on hand.

**The stopgap (built today):** someone is on hand only at the party's own small place (a district, building, room or site), or inside it. Everyone else can send word, or show as an unnamed sign with a notice roll, and the card tells the GM who's behind it ("Behind it, unseen: Zara the Unbound"). This is deliberately strict: until places have positions, Loom can't know who's a street away.

## The module

### 1. Places get positions

- Each place can have a pin on the campaign's map: x, y in the map's own units, and a scale set once ("this line is 10 miles").
- Small places (a room, a building) sit inside a pinned place and inherit its pin. Only places the party travels between need pins.
- The map can be a blank canvas or the GM's own map image, with pins dropped on it.
- Places with no pin still nest as they do now. Nothing breaks for a campaign without a map.

### 2. Distances and travel time, worked out

- Distance between two places is the straight line between their pins, times a terrain factor on the route (road 1, wilds 1.5, mountains 2: the place type gives a default; the GM can set it).
- Travel time comes from 5e paces: about 24 miles a day on foot at a normal pace, 3 miles an hour, faster mounted.
- Optional **routes** for when the straight line is wrong: a road, a river crossing, a pass. A route is a link between two places with its own length or time. A route that isn't there (a wall, a chasm) can be marked closed.

### 3. Who can be where, and when

- Everyone not with the party gets a **reach**: on hand (same small place), minutes away (same district or a short walk), hours away, a day or more, unknown.
- The engine reads it:
  - on hand: can act or walk in;
  - minutes away: can arrive this scene;
  - hours or more: sends word (a messenger takes the travel time), or arrives later, as a deadline-style complication ("Varek's riders reach the bridge by nightfall");
  - unknown: only a sign, or word.
- **People on the move:** "Varek is heading to the bridge, set out in session 6". With the in-game clock (`campaigns.in_game_date`, there today but rarely set), the engine works out where he is now. Moves can make "they arrive" a move whose timing is real.

### 4. In-game time

- Travel needs a clock. A quiet "time passes" control on the table page (an hour, until evening, a day), and the extractor proposes time passing from notes ("they rode for two days").
- Rests, deadlines and travel all read the same clock.

### 5. Within a scene (later)

- Zones for the current scene: close, near, far, hidden. These are for fights (who can reach whom this round) and for signs ("something moves at the far end of the hall"). They're worked out from the moment and the scene, not mapped.

### 6. Filling it in

- **By hand:** a Map page. Drop pins, drag them, draw a route, set the scale.
- **From notes:** the extractor proposes rough positions from what the notes say ("a day's ride north of Duradan", "across the river from the Woods"). Proposals go through the usual review, and a dragged pin is the DM's and stands.
- Blanks stay blanks: no pin is guessed without something in the notes.

## Build order

1. Pins and scale on places (schema, Map page with a blank canvas, drag to place). Reach worked out from pins; the strict stopgap stays for places without them.
2. Travel time and routes; the reach bands in presence and moves (arrive this scene vs later vs word).
3. The in-game clock and "time passes"; people on the move.
4. Positions proposed from notes.
5. Scene zones, with fights.

## Questions for Jacob

- **The map:** a blank canvas with pins first, or upload your own map image from the start?
- **Units:** miles (5e's travel table), or kilometres?
- **The clock:** should the table page show the in-game time and a "time passes" control, or is that too much at the table?
- **The stopgap:** is "on hand only at the party's own small place" too strict for now? A city campaign may want "same district" to count.
