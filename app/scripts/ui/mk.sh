# usage: bash mk.sh steps.tpl steps.json — replaces the string "__PRE__" with helpers.js + audit.js (run from this folder)
PRE=$(node -e "console.log(JSON.stringify(require('fs').readFileSync('helpers.js','utf8')+require('fs').readFileSync('audit.js','utf8')))")
node -e "const fs=require('fs');fs.writeFileSync(process.argv[2],fs.readFileSync(process.argv[1],'utf8').split('\"__PRE__\"').join(process.argv[3]))" "$1" "$2" "$PRE"
