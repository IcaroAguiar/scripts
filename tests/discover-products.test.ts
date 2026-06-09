import { describe, expect, test } from 'bun:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
  filterCoursesByProducts,
  loadProductLessonNameMapFromJson,
  loadProductsFromJson,
  normalizeProductName,
  parseProductsArg
} from '../src/scripts/discover-products';

describe('discover products helpers', () => {
  test('parses --products CSV from argv', () => {
    const parsed = parseProductsArg(['--products', 'Produto A, Produto B']);
    expect(parsed).toEqual(['Produto A', 'Produto B']);
  });

  test('parses --products=... syntax', () => {
    const parsed = parseProductsArg(['--products=Produto A,Produto B']);
    expect(parsed).toEqual(['Produto A', 'Produto B']);
  });

  test('loads and deduplicates products.name from mapping json', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'products-map-'));
    const file = path.join(tmp, 'map.json');
    await fs.writeJson(file, {
      trilhas: [
        { products: [{ name: 'Produto A' }, { name: 'Produto B' }] },
        { products: [{ name: 'Produto A' }, { name: '  Produto C  ' }] }
      ]
    });

    const { products, sourcePath } = await loadProductsFromJson(file);
    expect(sourcePath).toBe(path.resolve(file));
    expect(products).toEqual(['Produto A', 'Produto B', 'Produto C']);
  });

  test('normalizes accents/case/extra spaces for exact normalized matching', () => {
    expect(normalizeProductName('  Gestão de Tempo  ')).toBe('gestao de tempo');
    expect(normalizeProductName('GESTAO DE TEMPO')).toBe('gestao de tempo');
  });

  test('filters courses using exact normalized names and returns missing products', () => {
    const courses = [
      { id: '1', name: 'Alta Performance com Gustavo Borges', url: 'https://example.com/1' },
      { id: '2', name: 'Gestão de Tempo e Produtividade', url: 'https://example.com/2' }
    ];

    const { filteredCourses, missingProducts } = filterCoursesByProducts(courses, [
      'ALTA PERFORMANCE COM GUSTAVO BORGES',
      'Gestao de Tempo e Produtividade',
      'Produto Inexistente'
    ]);

    expect(filteredCourses.map((course) => course.id)).toEqual(['1', '2']);
    expect(missingProducts).toEqual(['Produto Inexistente']);
  });

  test('loads lesson names from products.lessons and products.modules.lessons', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lesson-map-'));
    const file = path.join(tmp, 'map.json');
    await fs.writeJson(file, {
      trilhas: [
        {
          products: [
            {
              name: 'Produto A',
              lessons: [{ name: 'Aula A1' }, { name: 'Aula A2' }]
            },
            {
              name: 'Produto B',
              modules: [
                { lessons: [{ name: 'Aula B1' }] },
                { lessons: [{ name: 'Aula B2' }, { name: 'Aula B3' }] }
              ]
            }
          ]
        }
      ]
    });

    const { lessonNamesByProductKey } = await loadProductLessonNameMapFromJson(file);
    expect(lessonNamesByProductKey.get(normalizeProductName('Produto A'))).toEqual(['Aula A1', 'Aula A2']);
    expect(lessonNamesByProductKey.get(normalizeProductName('Produto B'))).toEqual(['Aula B1', 'Aula B2', 'Aula B3']);
  });
});
