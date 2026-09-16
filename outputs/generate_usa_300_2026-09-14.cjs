'use strict';

const fs = require('node:fs');
const path = require('node:path');

const keys = ['C major','D major','E major','F major','G major','A major','Bb major','C minor','D minor','E minor','F# minor','G minor','A minor','B minor'];
const times = ['before sunrise','after the late shift','under the porch light','just past midnight','when the rain let up','on a clear Friday','before the town woke','after the last call'];
const weather = ['warm rain','dry wind','summer thunder','first cold air','low silver clouds','a clear blue morning','streetlight mist','late September sun'];
const hopes = ['a clean beginning','one honest answer','a road worth taking','a room that feels like home','the nerve to start again','a reason to stay kind','a little more daylight','a promise we can keep'];
const motions = ['turn the key','cross the county line','leave the old route','follow the river','take the slower highway','walk another block','let the record spin','open the window'];

const accounts = [
  {
    id: 'bos', handle: 'bos-423483424', album: "Miles We Haven't Named",
    left: ['Copper','Gravel','Bluebird','Cedar','Lantern','Western','Riverbend','Porchlight','County','Highway','Prairie','Smalltown','Red Clay','Late Shift','Water Tower','Pinewood','Open Road','Homebound','Rustbelt','Firefly'],
    right: ['Morning','Radio','Line','Weather','Letters'],
    scenes: ['a two-lane road outside Tulsa','a diner booth near Knoxville','a used truck outside Amarillo','a lakeside porch in Michigan','a grain elevator in Nebraska','a motel sign beyond Phoenix','a service station in Kentucky','a river bridge outside Memphis','a courthouse square in Georgia','a paper mill town in Maine','an empty fairground in Ohio','a peach stand in South Carolina','a ferry landing in Washington','a red-clay driveway in Alabama','a winter field in Wisconsin','a hardware store in Tennessee','a bus stop outside Austin','a water tower in Kansas','a mountain pass in Colorado','a harbor road in North Carolina'],
    objects: ['creased road map','paper coffee cup','faded work jacket','box of old photographs','brass motel key','handwritten grocery list','dashboard compass','borrowed acoustic guitar','postcard with no stamp','pair of muddy boots','late electric bill','small silver locket','ticket from the county fair','thermos full of coffee','baseball cap on the seat','receipt from a hardware store','polaroid from July','spare house key','radio with a broken dial','letter folded twice'],
    styles: [
      {name:'modern country-pop',bpm:[104,116],voice:'warm conversational male lead in clear American English',sound:'fingerpicked acoustic guitar, clean Telecaster answers, rounded bass, live kick and snare, restrained pedal steel'},
      {name:'Americana pop',bpm:[92,108],voice:'intimate expressive female lead in clear American English',sound:'dry acoustic guitar, upright piano, brushed drums, melodic bass, mandolin accents and soft harmony vocals'},
      {name:'heartland pop-rock',bpm:[112,128],voice:'earnest male lead in clear American English',sound:'open electric guitars, steady live drums, warm organ, driving bass and a wide singable chorus'},
      {name:'country-electronic crossover',bpm:[116,126],voice:'confident female lead in clear American English',sound:'acoustic guitar pulse, tight electronic kick, organic snare, pulsing bass, subtle banjo texture and bright synth lift'},
      {name:'cinematic country instrumental',bpm:[96,118],voice:'',sound:'acoustic guitar motif, warm piano, tasteful pedal steel, live drums, melodic bass and clean electric-guitar harmonies'}
    ]
  },
  {
    id: 'gleb', handle: 'nn1v-680019554', album: 'Signals After Closing',
    left: ['Neon','Static','Polaroid','Midnight','Satellite','Concrete','Velvet','Digital','Rooftop','Sidewalk','Silver','Afterimage','Backseat','Lowlight','Downtown','Paper','Glass','Nightbus','Daydream','Violet'],
    right: ['Pulse','Exit','Cinema','Signal','Fever'],
    scenes: ['the last train platform','a twenty-four-hour laundromat','the roof above a corner store','an empty downtown cinema','a rideshare at two in the morning','a bedroom lit by a laptop','the back row of a night bus','a parking garage in the rain','a kitchen after the party','a record shop near closing','a pedestrian bridge at dusk','a motel hallway by the airport','a basketball court under floodlights','a stairwell full of echoes','a convenience store on the east side','an apartment with paper blinds','a subway entrance in the snow','a rooftop above the traffic','a quiet booth in an arcade','a studio when the power flickers'],
    objects: ['cracked phone screen','train ticket in a coat pocket','disposable camera','headphones with one side out','receipt covered in blue ink','keycard that stopped working','half-finished voice note','silver lighter with no flame','playlist written on paper','borrowed black hoodie','photo strip from the mall','cheap digital watch','cassette with no label','metro card with one ride','small notebook of chords','takeout menu by the door','ring from a vending machine','USB drive on a chain','movie stub from last winter','pair of white sneakers'],
    styles: [
      {name:'alternative pop',bpm:[106,120],voice:'close dry male lead in natural American English',sound:'muted electric guitar, rounded synth bass, crisp acoustic snare, lightly swung percussion and stacked original harmonies'},
      {name:'melodic hip-hop pop',bpm:[82,98],voice:'rhythmic male lead shifting between melodic verses and a sung hook in American English',sound:'deep clean 808, clipped guitar sample, dry clap, rolling hi-hats, airy keys and a spacious hook'},
      {name:'indie alt-rock and hip-hop crossover',bpm:[112,130],voice:'restless gender-neutral lead in American English with a melodic chantable hook',sound:'distorted bass, live drums, wiry guitar, granular vocal-free textures and a half-time bridge'},
      {name:'dance-electronic alt-pop',bpm:[120,130],voice:'bright female lead in clear American English',sound:'punchy four-on-the-floor kick, elastic bass, glassy synth chords, chopped instrumental stabs and a euphoric original refrain'},
      {name:'atmospheric electronic instrumental',bpm:[108,126],voice:'',sound:'analog arpeggio, deep melodic bass, crisp electronic drums, textured guitar swells and a memorable synth lead'}
    ]
  },
  {
    id: 'rivi', handle: 'rivi-135338423', album: 'Rooms With The Lights Low',
    left: ['Honey','Sable','Moonlit','Satin','Golden','Slowburn','Orchid','Blue Hour','Softspoken','Rosewood','Warm Rain','Low Tide','Candlelight','Afterglow','Corner Booth','Summer Skin','Quiet Fire','Southside','Starlight','Sunday'],
    right: ['Motion','Room','Promise','Rhythm','Bloom'],
    scenes: ['an apartment above a bakery','a quiet booth near closing','a balcony after warm rain','a kitchen with one light on','a brownstone stair at sunset','a late train beside the river','a hotel lobby after midnight','a record player by the window','a corner table in New Orleans','a rooftop garden in Atlanta','a front stoop in Baltimore','a beach parking lot before dawn','a rehearsal room in Chicago','a cab moving through Brooklyn','a small gallery after the opening','a porch during summer thunder','a hallway outside apartment eleven','a café under amber lamps','a dance floor after everyone leaves','a bedroom facing the city'],
    objects: ['linen jacket over a chair','glass with melting ice','bouquet wrapped in newspaper','vinyl sleeve without the record','gold hoop earring by the sink','handwritten recipe card','silk scarf in a tote bag','small bottle of perfume','piano chord saved as a voice note','paper matchbook from a café','polaroid behind the mirror','library book with a pressed flower','train schedule folded in quarters','ceramic cup with a chipped rim','old key on a velvet ribbon','concert wristband from June','unfinished letter in a drawer','pair of dancing shoes','postcard from the coast','tiny lamp beside the bed'],
    styles: [
      {name:'contemporary R&B',bpm:[78,94],voice:'intimate expressive female lead in clear American English',sound:'felt Rhodes chords, warm sub bass, dry rimshot groove, brushed hi-hats, muted guitar motif and restrained stacked harmonies'},
      {name:'soulful modern pop',bpm:[88,106],voice:'warm male lead in clear American English with controlled falsetto accents',sound:'upright piano, round electric bass, live pocket drums, clean guitar, subtle strings and a strong original chorus'},
      {name:'Afro-soul R&B crossover',bpm:[100,116],voice:'smooth female lead in clear American English',sound:'syncopated percussion, soft electric piano, warm bass, palm-muted guitar, airy pads and a flowing melodic refrain'},
      {name:'disco-house R&B',bpm:[118,126],voice:'confident gender-neutral lead in American English',sound:'four-on-the-floor kick, live disco bass, clipped rhythm guitar, bright strings, soft house piano and soulful layered hooks'},
      {name:'late-night R&B instrumental',bpm:[82,104],voice:'',sound:'Wurlitzer chords, muted nylon guitar lead, rounded bass, relaxed drums, finger snaps and delicate vibraphone accents'}
    ]
  }
];

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
}
function pick(list,index) { return list[((index % list.length) + list.length) % list.length]; }
function bpmFor(style,index) { return style.bpm[0] + ((index * 7 + Math.floor(index / 5) * 3) % (style.bpm[1] - style.bpm[0] + 1)); }

function bosLyrics(title,index,c) {
  const scene=pick(c.scenes,index),object=pick(c.objects,index+7),time=pick(times,index),sky=pick(weather,index+2),hope=pick(hopes,index+4),motion=pick(motions,index+1);
  return `[Verse 1]\nWe met ${time} by ${scene}\nYou held a ${object} like it still knew where to go\nThe forecast promised ${sky}, the radio kept fading\nI said I had no answer, you said we could take it slow\n\n[Pre-Chorus]\nEvery mile behind us taught the wheels another language\nEvery light ahead was one more chance to let it show\n\n[Chorus]\n${title}, keep calling through the dashboard\n${title}, keep shining where the blacktop bends\nWe can ${motion}, we can carry what still matters\nWe can trade the weight we know for ${hope}\nIf the night gets long, let the honest song remind us\nThere is more than one way home before the highway ends\n\n[Verse 2]\nWe stopped for coffee where the county map was curling\nA waitress drew a shortcut on a napkin by your hand\nYou laughed about the plans we made to never need directions\nThen tucked that little drawing where the old receipts had been\n\n[Bridge]\nNo promise that the weather will be easy\nNo perfect line of headlights to defend\nJust your voice above the tires and the courage to begin\n\n[Chorus]\n${title}, keep calling through the dashboard\n${title}, keep shining where the blacktop bends\nWe can ${motion}, we can carry what still matters\nWe can trade the weight we know for ${hope}\nIf the night gets long, let the honest song remind us\nThere is more than one way home before the highway ends`;
}
function glebLyrics(title,index,c) {
  const scene=pick(c.scenes,index),object=pick(c.objects,index+9),time=pick(times,index+3),sky=pick(weather,index+5),hope=pick(hopes,index+1),motion=pick(motions,index+4);
  return `[Verse 1]\nI found your message ${time} near ${scene}\nThree little dots disappeared before the sentence had a name\nA ${object} was the only proof the weekend really happened\nOutside, ${sky} made every traffic light look strange\n\n[Pre-Chorus]\nI don't want the old reply\nI want something I can use tonight\n\n[Chorus]\n${title}, running bright across the ceiling\n${title}, tell me what the silence means\nI can ${motion}, I can quit rehearsing endings\nI can make a little room for ${hope}\nLet the bass line shake the picture out of focus\nLet the morning find me moving through the screen\n\n[Verse 2]\nEverybody at the station wore a different kind of distance\nI watched the doors divide the dark and put it back again\nI wrote a cleaner version of the truth inside my notebook\nThen crossed out every line that tried to make us only friends\n\n[Bridge]\nMaybe closure is a city with no exit\nMaybe freedom is the beat before it drops\nI don't need to know who wins this\nI just need to know the loop can stop\n\n[Chorus]\n${title}, running bright across the ceiling\n${title}, tell me what the silence means\nI can ${motion}, I can quit rehearsing endings\nI can make a little room for ${hope}\nLet the bass line shake the picture out of focus\nLet the morning find me moving through the screen`;
}
function riviLyrics(title,index,c) {
  const scene=pick(c.scenes,index),object=pick(c.objects,index+11),time=pick(times,index+1),sky=pick(weather,index+6),hope=pick(hopes,index+2),motion=pick(motions,index+6);
  return `[Verse 1]\nYou came ${time} to ${scene}\nSet a ${object} down beside the door\nThe room was holding ${sky} against the window\nWe spoke in careful chords we had not tried before\n\n[Pre-Chorus]\nNo need to make the moment louder\nI can hear the truth beneath your breath\n\n[Chorus]\n${title}, move slowly through the room now\n${title}, let the rhythm take its time\nWe can ${motion}, we can leave the fear behind us\nWe can turn this borrowed hour into ${hope}\nPut your hand where all the quiet turns to music\nStay until the last warm harmony unwinds\n\n[Verse 2]\nThe neighbors moved their chairs across the ceiling\nA taxi painted gold along the wall\nYou told me every brave thing starts in almost silence\nI watched your shadow soften when you heard my answer fall\n\n[Bridge]\nIf tomorrow asks for language we don't carry\nLet tonight become the sentence we can trust\nNot a promise made for strangers\nJust a patient kind of love between us\n\n[Chorus]\n${title}, move slowly through the room now\n${title}, let the rhythm take its time\nWe can ${motion}, we can leave the fear behind us\nWe can turn this borrowed hour into ${hope}\nPut your hand where all the quiet turns to music\nStay until the last warm harmony unwinds`;
}
function instrumentalCaption(account,title,style,bpm,key,index) {
  const forms=['quiet motif, layered verse-like development, broad refrain, stripped bridge and resolved final reprise','short atmospheric opening, two rising main sections, spacious breakdown, melodic return and clean outro','clear opening theme, rhythmic expansion, contrasting middle passage, brighter final statement and unhurried ending','minimal introduction, evolving groove, memorable chorus-like lead, half-time bridge and full final variation'];
  return `Original ${style.name}, ${bpm} BPM, ${key}. No vocals, humming, spoken word or vocal chops. ${style.sound}. Build ${pick(forms,index)}. Give “${title}” a distinct original melodic hook, natural dynamics, detailed modern stereo production and a clean ending suitable for an independent USA release.`;
}
function vocalCaption(account,title,style,bpm,key,index) {
  const forms=['intimate opening verse, wider pre-chorus, memorable full chorus, restrained bridge and brighter final chorus','short instrumental hook, close first verse, rising pre-chorus, wide melodic refrain, half-time bridge and confident final return','four-bar opening motif, rhythm-led verses, lift into a singable original hook, sparse middle eight and layered final chorus','immediate vocal entrance, controlled verse, strong melodic chorus, instrumental turnaround, quiet bridge and full closing refrain'];
  return `Original ${style.name} for a contemporary USA audience, ${bpm} BPM, ${key}. ${style.voice}. Production: ${style.sound}. Arrange a ${pick(forms,index)}. The song is titled “${title}”; keep the melody and phrasing original, emotionally direct and radio-clean, with no spoken introduction and no imitation of any existing artist.`;
}

const generated=[];
for(const account of accounts){
  for(let index=0;index<100;index++){
    const title=`${account.left[index%20]} ${account.right[Math.floor(index/20)]}`;
    const style=account.styles[index%account.styles.length], instrumental=index%5===4;
    const bpm=bpmFor(style,index),key=pick(keys,index*3+(account.id==='bos'?0:account.id==='gleb'?4:8));
    const lyrics=instrumental?'[Instrumental]':account.id==='bos'?bosLyrics(title,index,account):account.id==='gleb'?glebLyrics(title,index,account):riviLyrics(title,index,account);
    generated.push({
      release_title:title,
      output_name:`usa300_${account.id}_${String(index+1).padStart(3,'0')}_${slug(title)}`,
      target_account:account.handle,
      album_title:account.album,
      caption:instrumental?instrumentalCaption(account,title,style,bpm,key,index):vocalCaption(account,title,style,bpm,key,index),
      lyrics,
      duration:152+((index*11+(account.id==='bos'?3:account.id==='gleb'?7:13))%44),
      bpm,
      key_scale:key,
      time_signature:'4',
      vocal_language:instrumental?'unknown':'en',
      explicit:false
    });
  }
}

const titles=new Set(),names=new Set(),captions=new Set(),lyrics=new Set();
for(const [index,track] of generated.entries()){
  if(track.release_title.length>100)throw new Error(`Title too long at ${index+1}`);
  const titleKey=`${track.target_account}:${track.release_title.toLowerCase()}`;
  if(titles.has(titleKey))throw new Error(`Duplicate title: ${titleKey}`);titles.add(titleKey);
  if(names.has(track.output_name))throw new Error(`Duplicate output: ${track.output_name}`);names.add(track.output_name);
  if(captions.has(track.caption))throw new Error(`Duplicate caption: ${track.release_title}`);captions.add(track.caption);
  if(track.lyrics!=='[Instrumental]'&&lyrics.has(track.lyrics))throw new Error(`Duplicate lyrics: ${track.release_title}`);
  if(track.lyrics!=='[Instrumental]')lyrics.add(track.lyrics);
}
if(generated.length!==300)throw new Error(`Expected 300 tracks, got ${generated.length}`);

const main=path.join(__dirname,'USA_300_tracks_2026-09-14.json');
const sample=path.join(__dirname,'USA_300_first_3_2026-09-14.json');
fs.writeFileSync(main,JSON.stringify(generated,null,2)+'\n');
fs.writeFileSync(sample,JSON.stringify(accounts.map(account=>generated.find(track=>track.target_account===account.handle)),null,2)+'\n');
console.log(JSON.stringify({main,sample,total:generated.length,accounts:Object.fromEntries(accounts.map(account=>[account.id,generated.filter(track=>track.target_account===account.handle).length])),vocal:generated.filter(track=>track.vocal_language==='en').length,instrumental:generated.filter(track=>track.vocal_language==='unknown').length},null,2));
