#!/usr/bin/env python3
"""Read-only scanner for placed command blocks in Java Edition world ZIPs.

Usage:
    python3 scripts/scan_command_blocks.py
    python3 scripts/scan_command_blocks.py sample-map
    python3 scripts/scan_command_blocks.py "sample-map/1000mwr_v1.0.zip"

Requires only Python 3 standard library. Does not extract or modify input files.
Nested world ZIPs are supported; resource-pack ZIPs are skipped.
Output: JSON Lines, one record per world containing level.dat.

has_datapacks: whether installed datapack folders or ZIPs were found.
datapack_count/datapacks: number and names of packs with root pack.mcmeta.
Presence does not imply enabled, compatible, or containing game logic.
block_counts: actual placed blocks, counted from section state indices.
block_entities: command-block block entities (including empty commands).
nonempty_commands: block entities with a nonblank Command field.
minecarts: command-block minecart entities.
examples: up to three block-entity coordinates and command excerpts.
error_count/errors: read failures (errors contains up to three examples).
Zero blocks means none currently placed in saved chunks; it does not exclude
datapack logic, commands inside templates, or blocks created during gameplay.
Minimap's mcaddon is not a Java world and produces no world record.
"""
import zipfile,io,struct,zlib,gzip,json,time
from pathlib import Path
class NBT:
 def __init__(self,b): self.b=b; self.p=0
 def take(self,n): v=self.b[self.p:self.p+n]; self.p+=n; return v
 def num(self,f): return struct.unpack(">"+f,self.take(struct.calcsize(">"+f)))[0]
 def string(self): return self.take(self.num("H")).decode("utf-8","replace")
 def value(self,t):
  if t in (1,2,3,4,5,6): return self.num({1:"b",2:"h",3:"i",4:"q",5:"f",6:"d"}[t])
  if t==7: return self.take(self.num("i"))
  if t==8: return self.string()
  if t==9:
   k=self.num("B"); n=self.num("i"); return [self.value(k) for _ in range(n)]
  if t==10:
   d={}
   while True:
    k=self.num("B")
    if not k: return d
    name=self.string(); d[name]=self.value(k)
  if t in (11,12):
   n=self.num("i"); return list(struct.unpack(">"+str(n)+("i" if t==11 else "q"),self.take(n*(4 if t==11 else 8))))
  raise ValueError("NBT tag "+str(t))
 def root(self):
  t=self.num("B"); self.string(); return self.value(t)
IDS={"minecraft:command_block","minecraft:chain_command_block","minecraft:repeating_command_block"}

def find_datapacks(z, base, names, errors):
 """Find installed pack directories and ZIPs with pack.mcmeta at pack root."""
 prefix=base+"datapacks/"
 packs=set()
 for name in sorted(names):
  if not name.startswith(prefix):
   continue
  relative=name[len(prefix):]
  parts=relative.split("/")
  if len(parts)==2 and parts[0] and parts[1]=="pack.mcmeta":
   packs.add(parts[0])
  elif len(parts)==1 and relative.lower().endswith(".zip"):
   try:
    with zipfile.ZipFile(io.BytesIO(z.read(name))) as pack:
     if "pack.mcmeta" in pack.namelist():
      packs.add(relative)
   except Exception as error:
    errors.append(name+": "+str(error))
 return sorted(packs)

def scan(z,label):
 names=set(z.namelist()); levels=sorted(n for n in names if n=="level.dat" or n.endswith("/level.dat"))
 for level in levels:
  base=level[:-len("level.dat")]
  r={"world":label+"!"+base,"version":None,"terrain_chunks":0,"block_counts":{},"block_entities":0,"nonempty_commands":0,"minecarts":0,"examples":[],"errors":[]}
  try:
   lv=NBT(gzip.decompress(z.read(level))).root()["Data"]; r["version"]=lv.get("Version",{}); r["DataVersion"]=lv.get("DataVersion")
  except Exception as e:r["errors"].append(str(e))
  r["datapacks"]=find_datapacks(z,base,names,r["errors"])
  r["datapack_count"]=len(r["datapacks"])
  r["has_datapacks"]=bool(r["datapacks"])
  for name in sorted(names):
   if not name.startswith(base) or not name.endswith(".mca"):continue
   rel=name[len(base):]
   if "/region/" not in "/"+rel and "/entities/" not in "/"+rel: continue
   terrain="/region/" in "/"+rel
   try:
    b=z.read(name)
    for idx in range(1024):
     off=int.from_bytes(b[idx*4:idx*4+3],"big")*4096
     if not off: continue
     try:
      size=int.from_bytes(b[off:off+4],"big"); typ=b[off+4]; payload=b[off+5:off+4+size]
      if typ&128:
       parts=Path(name).name.split("."); cx=int(parts[1])*32+idx%32; cz=int(parts[2])*32+idx//32
       ext=str(Path(name).parent/("c.%d.%d.mcc"%(cx,cz))); payload=z.read(ext);typ &=127
      raw=gzip.decompress(payload) if typ==1 else zlib.decompress(payload) if typ==2 else payload if typ==3 else None
      if raw is None:raise ValueError("unsupported compression "+str(typ))
      if (r.get("DataVersion") or 0)>=1451 and not any(token in raw for token in (b"command_block",b"Control",b"MinecartCommandBlock")):
       if terrain:r["terrain_chunks"]+=1
       continue
      root=NBT(raw).root(); c=root.get("Level",root); ver=root.get("DataVersion",r.get("DataVersion") or 0)
      if terrain:
       r["terrain_chunks"]+=1
       for s in c.get("sections",c.get("Sections",[])):
        bs=s.get("block_states",{}); pal=bs.get("palette",s.get("Palette",[])); data=bs.get("data",s.get("BlockStates",[]))
        pal=[{"Name":p.split("[",1)[0]} if isinstance(p,str) else {"Name":p.get("Name",p.get("id",p.get("",""))).split("[",1)[0]} for p in pal]
        wanted={i:p.get("Name") for i,p in enumerate(pal) if p.get("Name") in IDS}
        if wanted:
         counts={i:0 for i in wanted}
         if len(pal)==1: counts={0:4096}
         elif data:
          bits=max(4,(len(pal)-1).bit_length()); mask=(1<<bits)-1; per=64//bits
          for j in range(4096):
           if ver>=2529: value=(data[j//per] & ((1<<64)-1)) >> ((j%per)*bits) & mask
           else:
            start=j*bits; word=start//64; shift=start%64; value=(data[word]&((1<<64)-1))>>shift
            if shift+bits>64:value|=(data[word+1]&((1<<64)-1))<<(64-shift)
            value &=mask
           if value in counts:counts[value]+=1
         else:raise ValueError("multi-entry command palette without state data")
         for i,n in counts.items():
          if n:r["block_counts"][wanted[i]]=r["block_counts"].get(wanted[i],0)+n
        blocks=s.get("Blocks")
        if blocks:
         for num,nm in [(137,"minecraft:command_block"),(210,"minecraft:repeating_command_block"),(211,"minecraft:chain_command_block")]:
          count=blocks.count(bytes([num]))
          if count:r["block_counts"][nm]=r["block_counts"].get(nm,0)+count
       for e in c.get("block_entities",c.get("TileEntities",[])):
        if e.get("id") in ("minecraft:command_block","Control","minecraft:control"):
         r["block_entities"]+=1; cmd=e.get("Command","")
         if cmd.strip():r["nonempty_commands"]+=1
         if len(r["examples"])<3:r["examples"].append({"region":rel,"xyz":[e.get(a) for a in ("x","y","z")],"command":cmd[:140]})
      for e in c.get("Entities",c.get("entities",[])):
       if e.get("id") in ("minecraft:command_block_minecart","MinecartCommandBlock"):r["minecarts"]+=1
     except Exception as e:r["errors"].append(name+" chunk "+str(idx)+": "+str(e))
   except Exception as e:r["errors"].append(name+": "+str(e))
  r["error_count"]=len(r["errors"]); r["errors"]=r["errors"][:3]
  print(json.dumps(r,ensure_ascii=False),flush=True)
 if levels:return
 for n in z.namelist():
  if n.lower().endswith(".zip") and "resource" not in n.lower():
   try:
    with zipfile.ZipFile(io.BytesIO(z.read(n))) as child:scan(child,label+"!"+n)
   except Exception as e:print(json.dumps({"archive_error":label+"!"+n,"error":str(e)},ensure_ascii=False),flush=True)
def main():
 import argparse
 parser=argparse.ArgumentParser(description="Java版ワールドZIP内の全ディメンションを走査し、配置済みコマンドブロックを数えます。結果は1ワールド1行のJSONです。")
 parser.add_argument("inputs", nargs="*", default=["sample-map"], help="ZIPファイル、またはZIPを含むディレクトリ（既定: sample-map）")
 args=parser.parse_args()
 for source in args.inputs:
  source=Path(source)
  if not source.exists():
   parser.error("入力が存在しません: "+str(source))
  paths=sorted(source.glob("*.zip")) if source.is_dir() else [source]
  for path in paths:
   with zipfile.ZipFile(path) as archive:
    scan(archive,str(path))

if __name__=="__main__":
 main()
