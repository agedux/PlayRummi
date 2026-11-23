import test from 'node:test'
import assert from 'node:assert/strict'
import {splitMelds} from '../rules.js'

test('inserting a duplicate six splits the run without reordering physical tiles',()=>{
  assert.deepEqual(splitMelds([2,3,4,5,57,6,7]),[[2,3,4,5],[57,6,7]])
})

test('valid runs and unfinished drafts keep their grouping',()=>{
  for (const row of [[2,3,4,5,6,7],[2,3,4,5,57,6]])
    assert.deepEqual(splitMelds(row),[row])
})
