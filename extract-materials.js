// extract-materials.js
// Extracts unique materials from recipes.json

const fs = require('fs');

const recipes = JSON.parse(fs.readFileSync('recipes.json', 'utf8'));

const materialsSet = new Set();

recipes.forEach(recipe => {
  if (recipe.material1 && recipe.material1.trim() !== '') {
    materialsSet.add(recipe.material1);
  }
  if (recipe.material2 && recipe.material2.trim() !== '') {
    materialsSet.add(recipe.material2);
  }
  if (recipe.material3 && recipe.material3.trim() !== '') {
    materialsSet.add(recipe.material3);
  }
  if (recipe.material4 && recipe.material4.trim() !== '') {
    materialsSet.add(recipe.material4);
  }
});

const materials = Array.from(materialsSet).sort();

console.log(`Found ${materials.length} unique materials`);

// Write to JSON
fs.writeFileSync('materials.json', JSON.stringify(materials, null, 2));
console.log('✓ materials.json created');

// Write to CSV
const csv = materials.map(m => m).join('\n');
fs.writeFileSync('materials.csv', 'Material_ID\n' + csv);
console.log('✓ materials.csv created');

// Write as JavaScript array for easy copying
const jsArray = `const MATERIALS = ${JSON.stringify(materials, null, 2)};\n\nmodule.exports = MATERIALS;`;
fs.writeFileSync('materials-list.js', jsArray);
console.log('✓ materials-list.js created');

console.log('\nSample materials:');
console.log(materials.slice(0, 10));
