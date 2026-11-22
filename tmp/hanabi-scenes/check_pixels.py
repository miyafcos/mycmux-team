from pathlib import Path
import argparse, json, hashlib
from PIL import Image, ImageChops, ImageStat
root=Path(__file__).resolve().parents[2]
# --shots <directory> reads captures elsewhere; --out <file> selects the audit JSON.
# Relative overrides are resolved from the caller's working directory by pathlib.
parser=argparse.ArgumentParser(description="Check Hanabi capture pixels")
parser.add_argument("--shots",type=Path,default=root/"tmp"/"hanabi-scenes"/"shots")
parser.add_argument("--out",type=Path,default=root/"tmp"/"hanabi-scenes"/"pixel-audit.json")
args=parser.parse_args()
shots=args.shots
image=Image.open(shots/"13-terminal-before-after.png").convert("RGB")
before=image.crop((0,36,1280,836));after=image.crop((1280,36,2560,836))
def avg_pixel(frame,x,y):
    pixels=[frame.getpixel((i,j)) for i in range(x-3,x+4) for j in range(y-3,y+4)]
    return [round(sum(p[c] for p in pixels)/len(pixels),2) for c in range(3)]
forest_diff=ImageChops.difference(before.crop((328,590,1280,695)),after.crop((328,590,1280,695)))
forest_max=max(value[1] for value in forest_diff.getextrema())
evidence={"forest_max_channel_difference":forest_max,"forest_mean_channel_difference":ImageStat.Stat(forest_diff).mean,"core":{"coordinate":[986,256],"before":avg_pixel(before,986,256),"after":avg_pixel(after,986,256)},
"forest_within_one_rgb_step":forest_max<=1,
"shots":[{"path":str(p),"size":list(Image.open(p).size),"sha256":hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(shots.glob("*.png"))]}
args.out.parent.mkdir(parents=True,exist_ok=True)
args.out.write_text(json.dumps(evidence,indent=2),encoding="utf-8")
assert len(evidence["shots"])==13
assert all(item["size"]==[1280,800] for item in evidence["shots"] if "still" in item["path"] or "merge" in item["path"])
assert evidence["core"]["after"][0]>evidence["core"]["before"][0]
print(json.dumps({key:value for key,value in evidence.items() if key!="shots"}))
