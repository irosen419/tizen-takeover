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

def sheet(sid, who, key, poses, aspect='21:9', note='', sizes=None, rows=1, found=None, scales=None, join=None):
    """rows/found describe what Gemini actually drew when it strayed from the brief:
    rows = how many rows the poses ended up in; found = a name for each pose cut.py
    detects, in reading order, with None for one to throw away. The first detected
    pose still sets the sheet's scale even when it is thrown away.
    scales = {pose: factor} for a pose drawn bigger or smaller than its neighbours.
    join = 'stack' or 'near' when one pose is made of separate pieces (see cut.py)."""
    SHEETS[sid] = dict(id=sid, who=who, key=key, rows=rows, poses=poses, aspect=aspect, note=note,
                       sizes=sizes, found=found, scales=scales or {}, join=join)

def prompt(sid):
    s = SHEETS[sid]
    n = len(s['poses'])
    keyname, keyword = KEYS[s['key']]
    lines = [INTRO[s['who']], '']
    lines.append(f"Make a pose sheet: ONE wide image with exactly {n} separate drawings of {WHAT[s['who']]}, lined up "
                 f"side by side in ONE single horizontal row (never two rows), evenly spaced like a line-up, in this "
                 f"order from left to right:")
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

# Poses Gemini added, or changed, that the briefs above don't describe.
EXTRA = {
    'ember/ball-down': "Lying down, side view facing right, guarding a yellow tennis ball between her front paws.",
    'ember/sock-proud': "Standing on all four legs, side view facing right, holding a white striped sock in her mouth.",
}

# -------------------------------------------------------------- sequences
# Frames that play in order. Stop-motion is choppy on purpose: two or three
# frames, held for a beat each, read as movement.
SEQUENCES = {
    'ian.walk': ['ian/walk-1', 'ian/walk-2'],
    'ian.run': ['ian/run-1', 'ian/run-2'],
    'ian.jump': ['ian/jump-crouch', 'ian/jump-leap', 'ian/jump-land'],
    'ian.throw': ['ian/throw-1', 'ian/throw-2'],
    'ian.dance': ['ian/dance-1', 'ian/dance-2'],
    'ian.wave': ['ian/stand', 'ian/stand-wave'],
    'ember.trot': ['ember/trot-1', 'ember/trot-2'],
    'ember.run': ['ember/run-1', 'ember/run-2'],
    'ember.jump': ['ember/jump-crouch', 'ember/jump-leap', 'ember/jump-land'],
    'ember.catch': ['ember/jump-crouch', 'ember/jump-catch', 'ember/jump-land'],
    'ember.roll': ['ember/down', 'ember/roll', 'ember/belly'],
    'ember.fetch': ['ember/run-1', 'ember/run-2', 'ember/stand-ball'],
    'ember.sock-heist': ['ember/sniff', 'ember/sock-proud', 'ember/sock-run'],
}
