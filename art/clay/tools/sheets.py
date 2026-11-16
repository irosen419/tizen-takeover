"""Pose sheets for the clay characters. Each sheet is one Gemini image holding a
single row of poses on a chroma-key backdrop; cut.py slices it into sprites.

The FIRST pose of every character sheet is an upright standing pose. cut.py
uses its height to bring every sheet to the same scale, so keep it standing
at full height with nothing raised above the head."""

ME = ("The first image is the approved model sheet of a clay puppet man; the second is a finished "
      "shot of him. Draw exactly this same puppet in every pose: the same face, thick black "
      "rectangular glasses, short dark beard with grey at the chin, high hairline with a small "
      "front tuft, small glossy black bead eyes, and the same chunky proportions (large head, about "
      "one third of his height, big simple hands). He always wears the same hoodie: three level "
      "bands of colour, sunny yellow on top (hood, shoulders, upper chest, upper arms), lavender "
      "across the middle (mid torso and elbows), bubblegum pink at the bottom (lower torso, "
      "forearms, cuffs), in a chunky quilted waffle grid, hood down, two yellow drawstrings with "
      "tan toggles. Dark indigo jeans, black skate sneakers with white soles.")

EMBER = ("The first image is the approved model sheet of a clay puppet dog; the second is a finished "
         "shot of her. Draw exactly this same puppet dog in every pose: the same face, small glossy "
         "black bead eyes peeking from under a curly fringe, a broad dark nose, long floppy ringlet "
         "ears, a coat of chunky hand-rolled spiral clay curls, sandy apricot with paler cream on the "
         "muzzle, chest and paws, a plumed curly tail and big rounded paws. No collar, no leash.")

DUO = ("The first image is the approved model sheet of a clay puppet man and the second the approved "
       "model sheet of his clay puppet dog; the third is a finished shot of them together, which "
       "also shows their relative size (she is a big dog). Draw exactly these same two puppets in "
       "every pose. The man: same face, thick black rectangular glasses, short dark beard with grey "
       "at the chin, high hairline with a small front tuft, and the same hoodie in three level bands, "
       "sunny yellow on top, lavender in the middle, bubblegum pink at the bottom, chunky quilted "
       "waffle grid, hood down, yellow drawstrings; dark indigo jeans, black skate sneakers with "
       "white soles. The dog: same face, bead eyes under a curly fringe, dark nose, floppy ringlet "
       "ears, chunky spiral clay curls, sandy apricot and cream. No collar, no leash.")

PROPS = ("The reference images show two clay puppets, a man and his dog, from a stop-motion film. "
         "Do NOT draw the puppets. Draw small props and effects for the same film, sculpted from "
         "the same hand-made plasticine clay with visible fingerprints, in the same chunky, simple, "
         "friendly style.")

KEYS = {
    'green': ('pure chroma-key green (#00FF00)', 'green'),
    'blue': ('pure chroma-key blue (#0000FF)', 'blue'),
}

REFS = {
    'ian': ['models/ian-model-sheet.jpg', 'models/ian-wave.jpg'],
    'ember': ['models/ember-model-sheet.jpg', 'models/ember-sit.jpg'],
    'duo': ['models/ian-model-sheet.jpg', 'models/ember-model-sheet.jpg', 'models/ian-and-ember.jpg'],
    'props': ['models/ian-and-ember.jpg'],
}
INTRO = {'ian': ME, 'ember': EMBER, 'duo': DUO, 'props': PROPS}
WHAT = {'ian': 'the same puppet', 'ember': 'the same puppet dog', 'duo': 'the same two puppets',
        'props': 'different small clay objects'}

SHEETS = {}

def sheet(sid, who, key, poses, aspect='21:9', note='', sizes=None, rows=None, found=None, scales=None, join=None,
          refs=None, ask_rows=1):
    """rows/found describe what Gemini actually drew when it strayed from the brief:
    rows = how many rows the poses ended up in; found = a name for each pose cut.py
    detects, in reading order, with None for one to throw away. The first detected
    pose still sets the sheet's scale even when it is thrown away.
    scales = {pose: factor} for a pose drawn bigger or smaller than its neighbours.
    join = 'stack' or 'near' when one pose is made of separate pieces (see cut.py).
    refs = [(path, what it is)]: extra pictures sent after the model sheets, such as
    an earlier sheet of the same puppet, so a new sheet keeps its look and size.
    ask_rows = how many rows to ask for (a walk cycle needs more poses than fit in
    one row); rows defaults to it."""
    SHEETS[sid] = dict(id=sid, who=who, key=key, rows=rows or ask_rows, poses=poses, aspect=aspect, note=note,
                       sizes=sizes, found=found, scales=scales or {}, join=join, refs=refs or [],
                       ask_rows=ask_rows)

def prompt(sid):
    s = SHEETS[sid]
    n = len(s['poses'])
    keyname, keyword = KEYS[s['key']]
    lines = [INTRO[s['who']]]
    for i, (_, what) in enumerate(s['refs'], len(REFS[s['who']]) + 1):
        lines.append(f"Image {i} is {what}")
    lines.append('')
    if s['ask_rows'] == 1:
        lines.append(f"Make a pose sheet: ONE wide image with exactly {n} separate drawings of {WHAT[s['who']]}, lined up "
                     f"side by side in ONE single horizontal row (never two rows), evenly spaced like a line-up, in this "
                     f"order from left to right:")
    else:
        per = -(-n // s['ask_rows'])
        lines.append(f"Make a pose sheet: ONE image with exactly {n} separate drawings of {WHAT[s['who']]}, in exactly "
                     f"{s['ask_rows']} rows of {per}, evenly spaced like a line-up, in this order: left to right along "
                     f"the top row, then left to right along the next row:")
    for i, (name, desc) in enumerate(s['poses'], 1):
        lines.append(f"{i}. {desc}")
    lines.append('')
    if s['who'] == 'props':
        lines.append("Each object is shown whole and about the same size as its neighbours, with a wide empty gap "
                     "of background between them: they never touch or overlap.")
    else:
        lines.append(f"Exactly {n} drawings, no more and no fewer, each pose drawn once. Every pose shows the whole "
                     "body, nothing cropped by the image edge. Leave a wide empty gap of background between "
                     "neighbours: poses never touch or overlap. Every pose is at exactly the same scale, as if shot "
                     "by one fixed camera: the head is the same size in every pose and no pose is drawn bigger than "
                     "the others. Do not draw any floor, ledge, seat, furniture or prop unless a pose names it.")
    if s['note']:
        lines.append(s['note'])
    lines.append("No borders, no dividing lines, no numbers, no captions, no text.")
    lines.append('')
    lines.append("LOOK: hand-made plasticine stop-motion clay exactly like the references, with visible "
                 "fingerprints and a soft waxy sheen, lit by soft neutral white studio light from the upper left.")
    lines.append(f"BACKGROUND: a perfectly flat, uniform {keyname} that fills the entire image edge to edge. No floor, "
                 f"no horizon, no gradient, no vignette, no texture. Nothing casts a shadow on the background and "
                 f"there are no ground shadows: everything simply floats in front of it. No {keyword} light, tint or "
                 f"reflection on the clay.")
    return '\n'.join(lines)

R = 'side view facing right'

# ------------------------------------------------------------------ the man
sheet('ian-move', 'ian', 'green', [
    ('stand', "Standing upright and relaxed, facing the camera, arms at his sides, warm half-smile."),
    ('walk-1', f"Walking, {R}, at the widest point of a stride: legs wide apart like open scissors, front heel just touching down, back foot on its toes, arms swinging opposite to the legs."),
    ('walk-2', f"Walking, {R}, the passing pose: standing tall on one straight leg, the other knee bent with its foot lifted just off the ground beside it, both arms hanging close to his sides."),
    ('run-1', f"Running flat out, {R}, at full stretch with both feet off the ground: front leg reaching far forward, back leg kicked up behind, arms pumping, grinning."),
    ('run-2', f"Running flat out, {R}, the passing pose: one foot planted on the ground under his body, the other knee lifted high in front, arms swapped."),
    ('skid', f"Skidding to a stop, {R}, leaning back, heels dug in, arms windmilling, eyebrows up in alarm."),
])
sheet('ian-jump', 'ian', 'green', [
    ('stand-proud', "Standing upright facing the camera, hands on his hips, proud grin."),
    ('jump-crouch', f"Winding up for a big jump, {R}: deep crouch, knees bent, arms swung far back, eyes fixed ahead."),
    ('jump-leap', f"Mid-air in a long jump, {R}: body stretched out, both arms reaching forward, legs trailing behind, hood flapping."),
    ('jump-tuck', "Mid-air in a joyful jump, facing the camera: knees pulled up, both arms thrown up, mouth open laughing."),
    ('jump-land', f"Landing from a jump, {R}: deep squat, one hand touching the ground, the other arm out for balance."),
    ('hang', "Hanging by both hands from an invisible bar above him, arms straight up, body and legs dangling, looking down nervously, facing the camera."),
], found=['stand-proud', 'jump-crouch', 'jump-leap', 'jump-tuck', 'jump-land', None],
   scales={'jump-crouch': 1.05, 'jump-leap': 1.12, 'jump-land': 1.05})  # hang: drew a bar; redone in ian-fix
sheet('ian-perch', 'ian', 'green', [
    ('stand-thumbs', "Standing upright facing the camera, giving a thumbs-up at chest height, pleased."),
    ('sit-edge', "Sitting on an invisible ledge, facing the camera, legs dangling and feet swinging, hands resting on the edge beside him, content."),
    ('climb', "Hauling himself up over an invisible ledge, facing the camera: both forearms flat on top of it, chin just above, one knee hooked up beside him, straining."),
    ('lie-chin', f"Lying on his stomach, {R}, propped on his elbows with his chin in his hands, feet kicked up behind him, daydreaming."),
    ('nap', "Lying flat on his back, seen from the side, hands behind his head, one knee up, eyes closed, fast asleep."),
    ('kneel-pet', f"Kneeling on one knee, {R}, leaning forward with one hand reaching down and forward, fingers wiggling, as if scratching a dog's belly, smiling."),
], found=['stand-thumbs', 'sit-edge', 'climb', 'nap', 'lie-chin', 'kneel-pet'],
   scales={'sit-edge': 1.15, 'climb': 1.12})  # nap and lie-chin came out stacked
sheet('ian-fetch', 'ian', 'green', [
    ('stand-wave', "Standing upright facing the camera, giving a small friendly wave with one hand at shoulder height."),
    ('throw-1', f"Winding up to throw a ball, {R}: weight on the back foot, throwing arm cocked far behind him, front arm pointing ahead. His hand is cupped but EMPTY: no ball."),
    ('throw-2', f"Just after the throw, {R}: lunging forward, throwing arm flung out in front, hand open and EMPTY, back foot off the ground."),
    ('cheer', "Jumping for joy facing the camera, both fists punched in the air, huge open-mouth grin."),
    ('point', f"Pointing ahead with his whole arm, {R}, other hand cupped at his mouth as he shouts, excited."),
    ('call', f"Crouched, {R}, slapping both hands on his knees to call the dog over, big encouraging smile."),
], found=[None, 'throw-1', 'throw-2', 'cheer', 'point', 'call'])  # the wave was left out; redone in ian-fix
sheet('ian-weather', 'ian', 'green', [
    ('stand-coffee', "Standing upright facing the camera, holding a white coffee mug in both hands at his chest, sleepy contented smile."),
    ('umbrella', "Standing facing the camera under an open bright red umbrella that he holds above his head, glancing up at the sky."),
    ('sunny', "Standing facing the camera in dark sunglasses instead of his usual glasses, holding an iced coffee with a straw, relaxed and cool."),
    ('cold', "Standing facing the camera with his hood UP over his head, hugging himself tightly, shoulders hunched, knees together, shivering."),
    ('windy', f"Leaning hard into a strong wind, {R}, one arm raised to shield his face, hood and drawstrings streaming out behind him."),
    ('hot', "Standing facing the camera, wilting in the heat: fanning his face with one hand, wiping his brow with the other arm, tongue out."),
], found=['stand-coffee', 'umbrella', 'sunny', 'cold', 'windy', None])  # hot: no glasses; redone in ian-fix
sheet('ian-home', 'ian', 'green', [
    ('stand-phone', "Standing upright facing the camera, looking down at a phone held in one hand at his chest, thumb scrolling."),
    ('laptop', "Sitting cross-legged, facing the camera at a slight angle, a silver laptop open on his lap, typing, absorbed."),
    ('popcorn', "Sitting cross-legged facing the camera, hugging a red-and-white striped popcorn bucket, tossing one piece of popcorn toward his open mouth."),
    ('checklist', "Standing facing the camera, holding a clipboard in one hand and ticking it with a pencil in the other, satisfied."),
    ('late', "Standing facing the camera, staring at the wristwatch on his raised forearm, eyebrows shot up, mouth a small O: he is late."),
    ('yawn', "Standing facing the camera in a big morning stretch: both arms up and out, back arched, eyes shut, huge yawn."),
], found=['stand-phone', None, 'popcorn', 'checklist', 'late', None])  # laptop had a logo, yawn no glasses; redone in ian-fix
sheet('ian-feels', 'ian', 'green', [
    ('stand-shrug', "Standing upright facing the camera, shrugging: shoulders up, palms turned up at shoulder height, eyebrows raised."),
    ('laugh', "Doubled over laughing, facing the camera at a slight angle, one arm across his belly, the other hand slapping his knee, eyes squeezed shut."),
    ('facepalm', "Standing facing the camera with one hand flat over his face, shoulders slumped."),
    ('dance-1', "Dancing, facing the camera: hips out to one side, one arm pointing up to the sky, the other pointing down, happy."),
    ('dance-2', "Dancing, facing the camera: the mirror move, hips out the other way, both arms bent in a goofy shuffle, one foot off the floor."),
    ('sneak', f"Sneaking on exaggerated tiptoe, {R}, knees high, shoulders hunched, one finger to his lips."),
])

# ---------------------------------------------------------------- the dog
sheet('ember-move', 'ember', 'blue', [
    ('stand', f"Standing square on all four legs, {R}, head up, mouth closed, calm."),
    ('trot-1', f"Trotting, {R}: one front leg and the opposite back leg stepping forward, tail up, cheerful."),
    ('trot-2', f"Trotting, {R}, the opposite step: the other front leg and the other back leg forward."),
    ('run-1', f"Galloping flat out, {R}, at full stretch with all four paws off the ground: front legs reaching far forward, back legs kicked out behind, ears streaming back, tongue out."),
    ('run-2', f"Galloping flat out, {R}, the gathered pose: all four paws bunched together under her arched body, ears flying up."),
    ('skid', f"Skidding to a stop, {R}: front legs braced stiff out in front, rump dropped low, ears flung forward, eyes wide."),
])
sheet('ember-jump', 'ember', 'blue', [
    ('stand-look', "Standing on all four legs, body turned three-quarters toward the camera, looking at the camera with a happy open mouth."),
    ('jump-crouch', f"Coiled to spring, {R}: rump down, chest low, front paws planted, eyes locked on something above and ahead."),
    ('jump-leap', f"Mid-air in a long leap, {R}: body stretched full length, front paws reaching forward, back legs trailing, ears streaming back."),
    ('jump-catch', f"Leaping straight up, {R}, to catch something: body nearly vertical, front paws tucked to her chest, head thrown back, mouth wide open."),
    ('jump-land', f"Landing from a leap, {R}: front paws touching down first, rump and back legs still high in the air."),
    ('bow', f"Play bow, {R}: chest and elbows flat on the ground, rump high in the air, tail wagging, cheeky grin."),
])
sheet('ember-floor', 'ember', 'blue', [
    ('stand-tilt', "Standing on all four legs facing the camera, head cocked far to one side, one ear dangling, curious."),
    ('sit', "Sitting upright facing the camera, front paws together, happy open-mouth smile, tongue showing."),
    ('belly', "Lying on her back, seen from the side, belly up, all four paws flopped in the air, head lolling toward the camera, tongue hanging out, blissful."),
    ('roll', "Half-way through rolling over, seen from the side: on her shoulder and side, legs kicking in the air, ears flopped on the ground, wriggling."),
    ('down', f"Lying down sphinx-style, {R}: belly on the ground, front paws stretched out ahead, head up and alert."),
    ('sleep', "Curled up tight in a doughnut, fast asleep, nose tucked against her tail, eyes closed."),
], scales={'belly': 1.35, 'roll': 1.35, 'down': 1.35, 'sleep': 1.35})  # the two front views were drawn bigger
sheet('ember-toys', 'ember', 'blue', [
    ('stand-ball', f"Standing on all four legs, {R}, proudly holding a yellow tennis ball in her mouth, tail high."),
    ('sock-run', f"Galloping away, {R}, with a white sock with two black stripes dangling from her mouth, ears flying, gleeful and guilty."),
    ('stick', f"Trotting, {R}, head held high, carrying a long brown stick crosswise in her mouth."),
    ('beg', "Sitting up on her haunches facing the camera, front paws tucked at her chest, head tilted, pleading."),
    ('tug', f"Playing tug, {R}: leaning hard backward with her rump low, teeth clamped on one end of a white sock with two black stripes that stretches out in front of her."),
    ('chew', f"Lying down, {R}, gnawing happily on a cream-coloured bone held upright between her front paws."),
], rows=2, found=['stand-ball', 'sock-run', 'stick', 'beg', 'ball-down', None, 'chew'])  # two rows, a bonus pose, and tug drawn with two dogs
sheet('ember-feels', 'ember', 'blue', [
    ('stand-bark', f"Standing on all four legs, {R}, head lifted, barking, mouth open."),
    ('howl', f"Sitting, {R}, nose pointed straight up at the sky, howling, mouth a small O."),
    ('shake', "Shaking herself off, facing the camera: whole coat twisting, ears and jowls flung out to one side, eyes squeezed shut."),
    ('sniff', f"Walking slowly, {R}, nose pressed to the ground, following a scent, tail up."),
    ('spin', "Chasing her own tail, seen from the side: body bent into a tight C, nose almost catching the tip of her tail."),
    ('scratch', "Sitting facing the camera at a slight angle, scratching behind her ear with a back paw, eyes half shut in bliss."),
])
sheet('ember-play', 'ember', 'blue', [
    ('stand-wag', f"Standing on all four legs, {R}, looking back over her shoulder at the camera, tail wagging."),
    ('pounce', f"Pouncing, {R}: front paws together stabbing down at the ground, rump and tail high, ears up."),
    ('dig', f"Digging furiously, {R}: head down, front paws scrabbling at the ground, rump up."),
    ('zoomies', f"Zoomies, {R}: sprinting low with her rump tucked under, eyes wide and wild, ears pinned back, tongue flapping."),
    ('lick', "Facing the camera very close, giving it a big sloppy lick: huge pink tongue stretched up toward the viewer, eyes happy."),
    ('paws-up', "Standing up on her back legs facing the camera, front paws hooked over an invisible ledge at chest height, peering over it."),
])

# --------------------------------------------------------------- together
sheet('duo-love', 'duo', 'green', [
    ('stand', "He stands upright facing the camera with one hand resting on her head; she stands on all four legs beside him, looking up at him."),
    ('belly-rub', "He kneels beside her scratching her belly with both hands, laughing; she lies on her back, wriggling in bliss, one back leg kicking the air."),
    ('hug', "He crouches with both arms around her neck in a big hug, eyes closed; she sits and licks his cheek, knocking his glasses crooked."),
    ('high-five', "He crouches holding one palm out; she sits and slaps a front paw onto it, a high five."),
    ('carry', "He carries her in both arms like a giant baby, leaning back and staggering under her weight; she looks delighted."),
])
sheet('duo-play', 'duo', 'green', [
    ('greet', "He stands upright, laughing; she stands up on her back legs with her front paws on his chest, licking his chin."),
    ('tug', "Tug of war: he pulls one end of a white sock with two black stripes, leaning back; she pulls the other end in her teeth, rump low. They face each other."),
    ('movie', "Seen from BEHIND: the two sit side by side on the floor, his arm around her shoulders, both looking away from the camera into the distance."),
    ('squash', "He lies flat on his stomach, squashed, arms spread, glasses crooked, chin on the floor; she sits proudly on his back, tongue out."),
    ('walk', f"Walking together, {R}: he strolls with his hands in his jeans pockets; she trots at his side looking up at him."),
], found=['greet', None, 'squash', 'walk'])  # tug and movie overlapped; redone in duo-fix

# ------------------------------------------------------ props and effects
# sizes: the longest side of each prop, as a fraction of the man's standing height
sheet('props-toys', 'props', 'blue', [
    ('ball', "A yellow tennis ball with a white seam."),
    ('sock', "A limp white sports sock with two black stripes around the cuff."),
    ('stick', "A knobbly brown stick, lying level."),
    ('frisbee', "A bright orange frisbee, tilted as if flying."),
    ('bone', "A cream-coloured dog bone."),
    ('bowl', "A red dog bowl heaped with brown kibble."),
], sizes=[0.09, 0.2, 0.42, 0.2, 0.16, 0.2], rows=2, found=[None] * 6 + ['ball', 'sock', 'stick', 'frisbee', 'bone', 'bowl'])  # top row is a blurred ghost copy
sheet('props-fx', 'props', 'green', [
    ('poof', "A puffy white dust cloud, the kind kicked up by a landing."),
    ('heart', "A plump red heart."),
    ('zed', "A single chunky lavender capital letter Z, for snoring."),
    ('star', "A yellow four-pointed sparkle star."),
    ('bang', "A fat red exclamation mark."),
    ('note', "A single black musical note."),
], sizes=[0.3, 0.12, 0.11, 0.12, 0.16, 0.16], join='stack')

# ------------------------------------------------------------------ redos
# Poses that came out wrong the first time (a missing pair of glasses, a logo,
# a drawn-in bar, two poses overlapping) and a few extras.
GLASSES = "He is wearing his usual thick black rectangular glasses."
sheet('ian-fix', 'ian', 'green', [
    ('stand-wave', "Standing upright facing the camera, one open hand raised beside his head in a friendly wave, smiling."),
    ('hang', "Dangling at full stretch, facing the camera: both arms straight up above his head, hands curled as if gripping the edge of something that is NOT drawn, body and legs hanging loose, looking down nervously."),
    ('hot', f"Standing facing the camera, wilting in the heat: fanning his face with one hand, the other arm hanging limp, tongue out, eyelids drooping. {GLASSES}"),
    ('yawn', f"Standing facing the camera in a big morning stretch: both arms up and out, back arched, eyes shut, mouth wide in a huge yawn. {GLASSES}"),
    ('laptop', "Sitting cross-legged, facing the camera at a slight angle, a plain silver laptop open on his lap, typing, absorbed. The laptop lid is completely blank: no logo, no symbol, no sticker."),
    ('back', "Seen from directly BEHIND: standing with his hands in his jeans pockets, looking away from the camera, hood hanging down his back."),
], note="Do not draw any bar, rail, pole or ledge anywhere.")
sheet('ember-fix', 'ember', 'blue', [
    ('stand-2', f"Standing square on all four legs, {R}, head up, mouth open in a pant."),
    ('tug', f"Playing tug, {R}: she leans hard backward with her rump low and front legs braced, teeth clamped on one end of a white sock with two black stripes. The rest of the sock stretches out level in front of her and its far end is held by nobody."),
    ('sit-side', f"Sitting upright, {R}, looking straight ahead, mouth closed, tail curled on the ground behind her."),
    ('look-up', "Sitting facing the camera, head tipped right back to stare straight up at the sky, mouth a little open, waiting for something to fall."),
    ('guilty', f"Lying flat, {R}, chin pressed to the ground between her front paws, ears drooping, eyes rolled up in a guilty look."),
    ('soggy', "Sitting facing the camera, soaked through: her curls flattened and hanging in wet strings, ears limp, thoroughly miserable."),
], note="There is exactly ONE dog in each pose, never two. Draw each pose once only: no second copy above it, no ghost image, no reflection, no motion blur.",
   found=['stand-2', 'sock-proud', 'sit-side', None, 'soggy'])  # tug became a proud sock carry; look-up and guilty overlapped
sheet('duo-fix', 'duo', 'green', [
    ('pals', "He stands upright facing the camera with his arms folded, grinning; she sits beside him facing the camera, tongue out."),
    ('tug', "Tug of war, seen from the side: he leans back pulling one end of a white sock with two black stripes with both hands; she faces him, rump low, pulling the other end in her teeth."),
    ('movie', "Seen from directly BEHIND: the two sit side by side on the floor, his arm around her shoulders, both looking away from the camera into the distance."),
], note="Three groups only, with a very wide gap of empty background between one group and the next.", join='near')
sheet('ember-fix2', 'ember', 'blue', [
    ('stand-3', f"Standing square on all four legs, {R}, head up, calm."),
    ('tug', f"Tug of war, {R}: her whole body leans steeply backward, all four legs braced out in front, rump almost on the ground, head low, growling playfully. One end of a white sock with two black stripes is clamped in her teeth and the sock is pulled out straight and level in front of her nose, as if someone outside the picture holds the other end. Do not draw them."),
    ('look-up', "Sitting facing the camera, head tipped right back to stare straight up at the sky, mouth a little open, waiting for something to fall."),
    ('guilty', f"Lying flat, {R}, chin pressed to the ground between her front paws, ears drooping, eyes rolled up in a guilty look."),
], note="There is exactly ONE dog in each pose, never two. Draw each pose once only: no second copy, no ghost image, no reflection, no motion blur. Four poses only, with a very wide gap of empty background between each.",
   found=[None, None, 'look-up', 'guilty'], scales={'look-up': 1.15, 'guilty': 1.15})

# ------------------------------------------------------------ gait cycles
# Real walk, trot and gallop cycles, several poses each, drawn on one sheet so
# they match. "Near" is the leg or arm closest to the camera, "far" the other.
# Each pose sits on one shared ground line per row, so cut.py's boxes show how
# high a flying pose is (LIFTS below).
GROUND_DOG = ("All drawings in a row share ONE level invisible ground line: every paw that touches the ground rests "
              "exactly on that line, and when she is in the air (no paw touching) she is drawn higher above it, by the "
              "height of her bound. Do not draw the line. These are the frames of ONE continuous movement, like an "
              "animator's key poses: the body, head, ears and tail stay the same size and the same look in every frame; "
              "only the legs, the bend of the back and the ears change. Every frame is clearly different from its "
              "neighbours.")
GROUND_MAN = ("All drawings in a row share ONE level invisible ground line: every foot that touches the ground rests "
              "exactly on that line, and when both feet are off the ground he is drawn higher above it. Do not draw the "
              "line. These are the frames of ONE continuous movement, like an animator's key poses: his head, glasses, "
              "beard and hoodie stay exactly the same size and look in every frame; only the legs, arms and the lean of "
              "the body change. Every frame is clearly different from its neighbours. He looks straight ahead in every "
              "frame, the same cheerful face.")
# An earlier sheet as a reference keeps the look, but Gemini copies its poses
# unless told not to (the first ember-trot and ian-walk came back as copies).
LOOK_ONLY = (" It is ONLY a reference for her look: do NOT copy its poses or its layout; every drawing in the new sheet is "
             "a new pose described below.")
EMBER_MOVE_REF = ('raw/ember-move.jpg', "an earlier approved pose sheet of the same puppet dog: draw her at exactly this "
                  "size and with exactly this look and curl texture." + LOOK_ONLY)

sheet('ember-gallop', 'ember', 'blue', [
    ('stand-4', f"Standing square on all four legs, {R}, head up, calm."),
    ('gallop-1', f"Gallop frame 1, {R}, GATHERED in the air: back strongly arched upward like a hump, all four paws bunched close together under her belly, front paws tucked back and back paws swung forward so they nearly touch, no paw on the ground, ears flying up."),
    ('gallop-2', f"Gallop frame 2, {R}, BACK PAWS LAND: both back paws planted on the ground under her belly, far forward, knees bent; front legs lifting and starting to reach forward, chest rising, back still rounded."),
    ('gallop-3', f"Gallop frame 3, {R}, PUSH-OFF: back legs straightening and pushing off behind her, only the back toes still touching the ground; body stretching long and rising toward the front; both front legs reaching forward and up."),
    ('gallop-4', f"Gallop frame 4, {R}, FULL STRETCH in the air: no paw on the ground, body flat and long, both front legs stretched far forward, both back legs stretched far back, ears streaming back, tongue out."),
    ('gallop-5', f"Gallop frame 5, {R}, REACHING DOWN: still stretched long, chest dipping, the front paws reaching down and the leading front paw just touching the ground in front of her; back legs still trailing high behind."),
    ('gallop-6', f"Gallop frame 6, {R}, FRONT LANDING: both front legs planted on the ground under her chest, straight; rump high, back legs trailing behind and off the ground, head low."),
    ('gallop-7', f"Gallop frame 7, {R}, SWING THROUGH: front legs pushing back behind her chest, front paws leaving the ground; back legs swinging forward under her belly, back beginning to arch; ears lifting."),
], aspect='16:9', ask_rows=2, refs=[EMBER_MOVE_REF], note=GROUND_DOG,
   found=[None] + [f'gallop-{i}' for i in range(1, 8)])
NEAR_DOG = (" Her NEAR legs are the two on the side closest to the camera, drawn in front of the body; her FAR legs are the "
            "other two, partly hidden behind it.")
sheet('ember-trot', 'ember', 'blue', [
    ('stand-5', f"Standing square on all four legs, {R}, head up, calm."),
    ('trot-a1', f"Trot frame 1, {R}, CONTACT: the near front leg reaches forward and its paw touches down in front of her chest, and at the same moment the far back leg reaches forward and its paw touches down under her belly; the other two legs (far front and near back) are stretched out behind, paws just leaving the ground. Tail up, cheerful."),
    ('trot-a2', f"Trot frame 2, {R}, WEIGHT DOWN: the near front leg and the far back leg are straight under her body carrying her weight; the far front leg and the near back leg are bent and swinging forward, paws lifted under her body. Body a little lower."),
    ('trot-a3', f"Trot frame 3, {R}, FLOATING: all four paws just off the ground; the far front leg and the near back leg reach forward, the near front leg and the far back leg trail behind. Body a little higher, ears lifting."),
    ('trot-b1', f"Trot frame 4, {R}, CONTACT on the other diagonal: the far front paw touches down in front of her chest and the near back paw touches down under her belly; the near front leg and the far back leg are stretched out behind, paws just leaving the ground."),
    ('trot-b2', f"Trot frame 5, {R}, WEIGHT DOWN on the other diagonal: the far front leg and the near back leg are straight under her body carrying her weight; the near front leg and the far back leg are bent and swinging forward, paws lifted under her body."),
    ('trot-b3', f"Trot frame 6, {R}, FLOATING again: all four paws just off the ground; the near front leg and the far back leg reach forward, the far front leg and the near back leg trail behind."),
], aspect='16:9', ask_rows=2, refs=[EMBER_MOVE_REF], note=GROUND_DOG + NEAR_DOG,
   found=[None] + [f'trot-{p}' for p in ('a1', 'a2', 'a3', 'b1', 'b2', 'b3')])

# The man's walk comes in two sheets, one per leg, five drawings in one row like
# ian-move. A ten-drawing sheet with ian-move as a reference came back as half
# copies of ian-move (even when told not to copy), so his sheets use only the
# model sheets.
def walk_half(lead, trail, n0):
    return [
        (f'walk-{n0}', f"Walk, {R}, CONTACT: his {lead} leg straight out in front with its heel just touching down, his {trail} leg stretched behind on its toes; his {trail} arm swung forward, his {lead} arm swung back."),
        (f'walk-{n0 + 1}', f"Walk, {R}, DOWN: his {lead} foot flat on the ground in front, {lead} knee bent taking his weight, body at its lowest; his {trail} foot behind with its heel lifting; {trail} arm still forward, {lead} arm back."),
        (f'walk-{n0 + 2}', f"Walk, {R}, PASSING: standing tall on his straight {lead} leg right under his body; his {trail} leg bent at the knee and swinging forward beside it, that foot lifted just off the ground; both arms hanging near his sides."),
        (f'walk-{n0}-up', f"Walk, {R}, UP: rising onto the toes of his {lead} foot, now behind him; his {trail} leg swinging out straight in front, its foot not yet touching; body at its highest; {lead} arm swinging forward, {trail} arm back."),
    ]
STAND_SIDE = ('stand-side', f"Standing upright, {R}, arms relaxed at his sides, feet together, looking ahead, calm half-smile.")
NEAR_MAN = (" His NEAR leg and arm are the ones on the side closest to the camera, drawn in front of his body; his FAR leg and "
            "arm are the other ones, partly hidden behind his body. Arms always swing opposite to the legs.")
# The UP frames came back as a second contact pose, which made the cycle step
# twice, so each half keeps three frames: contact, down, passing.
sheet('ian-walk-a', 'ian', 'green', [STAND_SIDE] + walk_half('near', 'far', 3), note=GROUND_MAN + NEAR_MAN,
      found=['stand-side', 'walk-3', 'walk-4', 'walk-5', None])
sheet('ian-walk-b', 'ian', 'green', [STAND_SIDE] + walk_half('far', 'near', 6), note=GROUND_MAN + NEAR_MAN,
      found=[None, 'walk-6', 'walk-7', 'walk-8', None])

# A first try at the run (one sheet per leg: push-off, flight, landing, passing)
# came back as eight near-identical scissor strides. This one asks for three
# poses that look different: contact, passing (knee high) and flight.
def run3(plant, swing, n0):
    return [
        (f'run-{n0}', f"Running, {R}, CONTACT: his {plant} foot has just landed flat on the ground a little in front of his hips, that knee slightly bent; his {swing} leg is behind him, bent at the knee with the foot up off the ground behind; body leaning forward; {swing} arm bent and forward, {plant} arm bent and back."),
        (f'run-{n0 + 1}', f"Running, {R}, PASSING: standing on his {plant} leg, which is bent a little right under his body with the foot flat; his {swing} knee is driven HIGH up in front of him, thigh level with the ground, foot tucked under it; arms pumping, {swing} arm back, {plant} arm forward. A compact pose."),
        (f'run-{n0 + 2}', f"Running, {R}, FLIGHT: both feet clearly off the ground, legs split wide: his {plant} leg stretched straight out behind him after pushing off, his {swing} leg reaching far forward; arms pumping wide. A long stretched pose."),
    ]
sheet('ian-run', 'ian', 'green', [STAND_SIDE] + run3('near', 'far', 3) + run3('far', 'near', 6),
      aspect='16:9', ask_rows=2, note=GROUND_MAN + NEAR_MAN, found=[None] + [f'run-{n}' for n in range(3, 9)])

# Carrying a toy: the same cycles redrawn from the accepted sheets, so the
# poses match the plain trot and gallop frame for frame.
TOY = ("Image 3 shows the frames of her {gait}. Redraw EXACTLY those same {n} drawings in the same layout, order and "
       "poses, with one change: in every drawing she carries {toy}.")
BALL = "a yellow tennis ball with a white seam, held in her front teeth"
SOCK = "a limp white sports sock with two black stripes around the cuff, one end clamped in her teeth and the rest dangling and flapping from the side of her mouth"
sheet('ember-ball-trot', 'ember', 'blue', [
    ('stand-ball-2', f"Standing square on all four legs, {R}, head up, holding {BALL}."),
    ('ball-trot-a1', "Trot frame 1 (copy of the second drawing in image 3), with the ball."),
    ('ball-trot-a2', "Trot frame 2 (copy of the third drawing in image 3), with the ball."),
    ('ball-trot-a3', "Trot frame 3 (copy of the fourth drawing in image 3), with the ball."),
    ('ball-trot-b1', "Trot frame 4 (copy of the fifth drawing in image 3), with the ball."),
    ('ball-trot-b2', "Trot frame 5 (copy of the sixth drawing in image 3), with the ball."),
    ('ball-trot-b3', "Trot frame 6 (copy of the seventh drawing in image 3), with the ball."),
], aspect='16:9', ask_rows=2, refs=[('raw/ember-trot.jpg', "the approved trot sheet of the same puppet dog.")],
   note=TOY.format(gait='trot', n=7, toy=BALL) + " " + GROUND_DOG, found=[None] + [f'ball-trot-{p}' for p in ('a1', 'a2', 'a3', 'b1', 'b2', 'b3')])
sheet('ember-sock-run', 'ember', 'blue', [
    ('stand-sock', f"Standing square on all four legs, {R}, head up, holding {SOCK}."),
] + [(f'sock-run-{i}', f"Gallop frame {i} (copy of drawing {i + 1} in image 3), with the sock.") for i in range(1, 8)],
   aspect='16:9', ask_rows=2, refs=[('raw/ember-gallop.jpg', "the approved gallop sheet of the same puppet dog.")],
   note=TOY.format(gait='gallop', n=8, toy=SOCK) + " " + GROUND_DOG, found=[None] + [f'sock-run-{i}' for i in range(1, 8)])

# Poses Gemini added, or changed, that the briefs above don't describe.
EXTRA = {
    'ember/ball-down': "Lying down, side view facing right, guarding a yellow tennis ball between her front paws.",
    'ember/sock-proud': "Standing on all four legs, side view facing right, holding a white striped sock in her mouth.",
}
# The ball and sock cycles were asked for as copies of another sheet; say what they show.
for _p in ('a1', 'a2', 'a3', 'b1', 'b2', 'b3'):
    EXTRA[f'ember/ball-trot-{_p}'] = f"Trotting, {R}, with a yellow tennis ball in her mouth: the pose of ember/trot-{_p}."
for _i in range(1, 8):
    EXTRA[f'ember/sock-run-{_i}'] = f"Galloping, {R}, with a white striped sock in her mouth: the pose of ember/gallop-{_i}."


# -------------------------------------------------------------- sequences
# Frames that play in order. Most are two or three frames held for a beat each;
# the walks, trots and gallops are full cycles that loop (see STRIDES and LIFTS).
SEQUENCES = {
    'ian.walk': ['ian/walk-3', 'ian/walk-4', 'ian/walk-5', 'ian/walk-6', 'ian/walk-7', 'ian/walk-8'],
    'ian.run': ['ian/run-3', 'ian/run-4', 'ian/run-5', 'ian/run-6', 'ian/run-7', 'ian/run-8'],
    'ian.jump': ['ian/jump-crouch', 'ian/jump-leap', 'ian/jump-land'],
    'ian.throw': ['ian/throw-1', 'ian/throw-2'],
    'ian.dance': ['ian/dance-1', 'ian/dance-2'],
    'ian.wave': ['ian/stand', 'ian/stand-wave'],
    'ember.trot': ['ember/trot-a1', 'ember/trot-a2', 'ember/trot-a3', 'ember/trot-b1', 'ember/trot-b2', 'ember/trot-b3'],
    'ember.run': ['ember/gallop-1', 'ember/gallop-2', 'ember/gallop-3', 'ember/gallop-4', 'ember/gallop-5',
                  'ember/gallop-6', 'ember/gallop-7'],
    'ember.jump': ['ember/jump-crouch', 'ember/jump-leap', 'ember/jump-land'],
    'ember.catch': ['ember/jump-crouch', 'ember/jump-catch', 'ember/jump-land'],
    'ember.roll': ['ember/down', 'ember/roll', 'ember/belly'],
    'ember.fetch': ['ember/run-1', 'ember/run-2', 'ember/stand-ball'],
    'ember.sock-heist': ['ember/sniff', 'ember/sock-proud', 'ember/sock-run'],
    'ember.ball-trot': ['ember/ball-trot-a1', 'ember/ball-trot-a2', 'ember/ball-trot-a3', 'ember/ball-trot-b1',
                        'ember/ball-trot-b2', 'ember/ball-trot-b3'],
    'ember.sock-run': ['ember/sock-run-1', 'ember/sock-run-2', 'ember/sock-run-3', 'ember/sock-run-4',
                       'ember/sock-run-5', 'ember/sock-run-6', 'ember/sock-run-7'],
}

# Px travelled per full cycle of a gait sequence, at the exported size (Ian
# standing = 160 px), so a planted foot stays put while the body moves on.
STRIDES = {
    'ian.walk': 86,
    'ian.run': 230,
    'ember.trot': 90,
    'ember.run': 120,
    'ember.ball-trot': 90,
    'ember.sock-run': 120,
}

# Px above the floor line for frames where nothing touches the ground. A sprite's
# bottom is its lowest pixel, so without this a leap would sit on the floor.
# Measured from where each pose sat on its sheet against the poses with a foot
# down in the same row (cut.py's boxes), rounded down a little.
LIFTS = {
    'ian/run-5': 12,
    'ian/run-8': 14,
    'ember/trot-a3': 8,
    'ember/trot-b3': 3,
    'ember/gallop-1': 14,
    'ember/gallop-4': 11,
    'ember/gallop-7': 4,
    'ember/ball-trot-a3': 8,
    'ember/ball-trot-b3': 3,
    'ember/sock-run-1': 14,
    'ember/sock-run-4': 11,
    'ember/sock-run-7': 4,
}
