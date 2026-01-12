#!/usr/bin/env node
/**
 * Posts PR review comments to GitHub
 * Takes violations.json and posts them as a review
 */

const fs = require('fs');

async function postReview(github, context) {
  let comments = [];

  try {
    const output = fs.readFileSync('violations.json', 'utf8');
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      comments = JSON.parse(jsonMatch[0]);
    }
  } catch (error) {
    console.log('Could not parse violations:', error.message);
  }

  console.log(`Found ${comments.length} violations to post`);

  if (comments.length > 0) {
    const reviewComments = comments.map(c => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: c.body
    }));

    try {
      await github.rest.pulls.createReview({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.issue.number,
        body: `## 🔍 Code Standards Review\n\nFound ${comments.length} violation(s) that need to be resolved. See inline comments below.`,
        event: 'REQUEST_CHANGES',
        comments: reviewComments.slice(0, 30)
      });
      console.log('✓ Review posted successfully!');
    } catch (error) {
      console.log('Could not post review:', error.message);
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: `## 🔍 Code Standards Violations\n\nFound ${comments.length} violations. Check logs for details.`
      });
    }
  } else {
    console.log('✓ No violations found!');
  }
}

module.exports = postReview;
