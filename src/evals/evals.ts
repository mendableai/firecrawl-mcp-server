//evals.ts

import { EvalConfig } from 'mcp-evals';
import { openai } from "@ai-sdk/openai";
import { grade, EvalFunction } from "mcp-evals";

const firecrawl_scrapeEval: EvalFunction = {
    name: 'firecrawl_scrape Tool Evaluation',
    description: 'Evaluates the firecrawl_scrape tool scraping functionality',
    run: async () => {
        const result = await grade(openai("gpt-4"), "Use the firecrawl_scrape tool to scrape the main content of https://example.com and return it in Markdown format.");
        return JSON.parse(result);
    }
};

const firecrawl_batch_scrapeEval: EvalFunction = {
    name: 'firecrawl_batch_scrape',
    description: 'Evaluates the batch scraping of multiple URLs',
    run: async () => {
        const result = await grade(openai("gpt-4"), "Please perform a batch scrape of https://example.com, https://wikipedia.org, and https://google.com using Firecrawl.");
        return JSON.parse(result);
    }
};

const firecrawl_searchEval: EvalFunction = {
    name: 'firecrawl_search Evaluation',
    description: 'Evaluates the correctness and completeness of the firecrawl_search tool results',
    run: async () => {
        const result = await grade(openai("gpt-4"), "Search for the best pizza in New York City");
        return JSON.parse(result);
    }
};

const firecrawl_crawlEval: EvalFunction = {
    name: "Firecrawl_Crawl Tool Evaluation",
    description: "Evaluates the functionality of the firecrawl_crawl tool",
    run: async () => {
        const result = await grade(openai("gpt-4"), "Please start a crawl of https://example.com and provide the job ID");
        return JSON.parse(result);
    }
};

const firecrawl_scrapeEval: EvalFunction = {
    name: 'firecrawl_scrape Evaluation',
    description: 'Evaluates the functionality of the firecrawl_scrape tool',
    run: async () => {
        const result = await grade(openai("gpt-4"), "Please scrape the webpage at https://example.com in markdown format, extracting only the main content and waiting 3000ms for dynamic elements to load, excluding script tags.");
        return JSON.parse(result);
    }
};

const config: EvalConfig = {
    model: openai("gpt-4"),
    evals: [firecrawl_scrapeEval, firecrawl_batch_scrapeEval, firecrawl_searchEval, firecrawl_crawlEval, firecrawl_scrapeEval]
};
  
export default config;
  
export const evals = [firecrawl_scrapeEval, firecrawl_batch_scrapeEval, firecrawl_searchEval, firecrawl_crawlEval, firecrawl_scrapeEval];